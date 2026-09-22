/**
 * Computer lifecycle owned by the bridge.
 *
 * Ownership rules enforced here:
 * - Identity is the caller's session-derived `botId`, so the same conversation
 *   resumes the same computer after a restart. Rakazo's API decides the space
 *   and home that identity belongs to.
 * - A caller may act on a computer only while presenting the capability this
 *   process issued for that exact computer. Capabilities live in memory only,
 *   so a restart invalidates them and no on-disk or in-environment copy of an
 *   authorization can exist.
 * - Operations on one computer are serialized, so a concurrent stop cannot
 *   interleave with a command, and destructive calls are idempotent.
 * - Only computers this process created are addressable, so Rakazo's own bots
 *   cannot be reached even by a guessed identifier.
 *
 * Nothing here is persisted: machine lifecycle belongs to Rakazo, which
 * suspends idle computers and restores workspaces, and ownership belongs to the
 * calling session, which derives the same identity again next boot.
 */
import { createHash, randomBytes } from "node:crypto";

/** Unguessable capability handed to exactly one caller. */
const newCapability = () => randomBytes(32).toString("hex");

const capabilityHash = (capability) => createHash("sha256").update(capability).digest("hex");

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 300_000;
/** States that need no probe: the computer is already gone. */
const TERMINAL_STATES = new Set(["destroyed", "missing"]);

export class ControlError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

export const badRequest = (message) => new ControlError(400, message);
export const forbidden = (message) => new ControlError(403, message);
export const notFound = (message) => new ControlError(404, message);

function identifier(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw badRequest(`${name} must be an identifier`);
  }
  return value;
}

/** Workspace-relative path; lexical traversal and absolute paths are rejected. */
function relativePath(value) {
  if (typeof value !== "string") throw badRequest("path must be a string");
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.some((part) => part === "." || part === "..")) throw badRequest("path escapes workspace");
  return parts.join("/");
}

function commandArgv(value) {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || !item)) {
    throw badRequest("argv must be a non-empty string array");
  }
  return value;
}

function timeoutMs(value) {
  if (value === undefined || value === null) return undefined;
  if (!Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) {
    throw badRequest(`timeoutMs must be an integer between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

/** A provider error that means the container is gone maps to our own not-found. */
function translate(error) {
  if (error?.statusCode === 404) return notFound("computer no longer exists");
  if (error?.statusCode === 403) return forbidden("computer identity was rejected");
  if (error?.statusCode === 400) return badRequest(error.message);
  return error;
}

export class ComputerControl {
  #locks = new Map();

  constructor({ api }) {
    this.api = api;
    /** computerId -> record. Process-local by design: see the ownership rules. */
    this.computers = new Map();
  }

  /** One critical section per computer; the chain never rejects for the next caller. */
  #lock(key, work) {
    const previous = this.#locks.get(key) ?? Promise.resolve();
    const settled = previous.then(work, work);
    this.#locks.set(
      key,
      settled.then(
        () => undefined,
        () => undefined,
      ),
    );
    return settled;
  }

  #entry(computerId, capability, { allowTerminal = false, adopt = false } = {}) {
    const key = identifier(computerId, "computerId");
    const entry = this.computers.get(key);
    if (!entry || !entry.id) throw notFound("unknown computer");
    if (!allowTerminal && TERMINAL_STATES.has(entry.state)) throw notFound("computer is no longer available");
    // Adoption is the bridge's own bookkeeping path (reclaiming a computer whose
    // owning session is gone, so no capability can still exist for it). It stays
    // a separate flag rather than a bypass, so an ordinary call can never use it.
    if (!adopt && (typeof capability !== "string" || capabilityHash(capability) !== entry.capabilityHash)) {
      throw forbidden("invalid computer capability");
    }
    return entry;
  }

  /** Rakazo exposes no inspect, so one trivial command is the liveness signal. */
  async #probeState(entry) {
    const probe = await this.api.exec(entry, { argv: ["/bin/true"] });
    if (probe.code === 0) return "running";
    return /\b404\b/.test(probe.stderr ?? "") ? "missing" : "stopped";
  }

  /**
   * Hand the caller the computer its session identity owns. Rakazo re-adopts an
   * existing machine for a known `botId` and provisions one otherwise, so this
   * is both create and resume: the same session gets the same computer back
   * after a restart, and no record of the previous process is needed.
   */
  async create(input) {
    const botId = identifier(input?.botId, "botId");
    return this.#lock(`bot:${botId}`, async () => {
      const created = await this.api.provision({ botId });
      if (typeof created.id !== "string" || !created.id) {
        throw new ControlError(502, "rakazo api returned no computer id");
      }
      // Re-issuing on every call keeps the capability process-local: a restart
      // forgets it, and the session that owns the identity gets a fresh one.
      const capability = newCapability();
      const previous = this.computers.get(created.id);
      this.computers.set(created.id, {
        id: created.id,
        botId,
        capabilityHash: capabilityHash(capability),
        createdAt: previous?.createdAt ?? new Date().toISOString(),
        state: "running",
      });
      return { computerId: created.id, capability, botId, resumed: created.resumed === true };
    });
  }

  /** Live computers only; capabilities are never returned. */
  list() {
    return [...this.computers.values()]
      .filter((entry) => entry.id && !TERMINAL_STATES.has(entry.state))
      .map((entry) => ({
        computerId: entry.id,
        botId: entry.botId,
        state: entry.state,
        createdAt: entry.createdAt,
      }));
  }

  async status(computerId, capability) {
    const entry = this.#entry(computerId, capability);
    return this.#lock(entry.id, async () => {
      const state = await this.#probeState(entry).catch((error) => {
        throw translate(error);
      });
      entry.state = state;
      return { computerId: entry.id, running: state === "running", state };
    });
  }

  async exec(computerId, capability, input) {
    const entry = this.#entry(computerId, capability);
    const argv = commandArgv(input?.argv);
    const cwd = input?.cwd === undefined ? "" : relativePath(input.cwd);
    const limit = timeoutMs(input?.timeoutMs);
    return this.#lock(entry.id, () =>
      this.api.exec(entry, { argv, cwd, timeoutMs: limit }).catch((error) => {
        throw translate(error);
      }),
    );
  }

  async readFile(computerId, capability, relativeInput) {
    const entry = this.#entry(computerId, capability);
    const relative = relativePath(relativeInput);
    return this.#lock(entry.id, () =>
      this.api.readFile(entry, relative).catch((error) => {
        throw translate(error);
      }),
    );
  }

  async writeFile(computerId, capability, input) {
    const entry = this.#entry(computerId, capability);
    const relative = relativePath(input?.path);
    if (typeof input?.content !== "string") throw badRequest("content must be a string");
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.byteLength > MAX_FILE_BYTES) throw badRequest("content exceeds the 16 MiB limit");
    return this.#lock(entry.id, () =>
      this.api
        .writeFile(entry, {
          relative,
          contentBase64: bytes.toString("base64"),
          executable: input.executable === true,
        })
        .catch((error) => {
          throw translate(error);
        }),
    );
  }

  /** `screenId` selects the caller's own display on a shared computer. */
  async observe(computerId, capability, { screenId } = {}) {
    const entry = this.#entry(computerId, capability);
    return this.#lock(entry.id, () =>
      this.api.observe(entry, { screenId }).catch((error) => {
        throw translate(error);
      }),
    );
  }

  async browser(computerId, capability, payload, { screenId } = {}) {
    const entry = this.#entry(computerId, capability);
    const command = payload?.command;
    if (command !== "navigate" && command !== "snapshot" && command !== "act") {
      throw badRequest("command must be navigate, snapshot, or act");
    }
    return this.#lock(entry.id, () =>
      this.api.browser(entry, payload, { screenId }).catch((error) => {
        throw translate(error);
      }),
    );
  }

  async stop(computerId, capability) {
    const entry = this.#entry(computerId, capability, { allowTerminal: true });
    return this.#lock(entry.id, async () => {
      if (entry.state === "stopped" || TERMINAL_STATES.has(entry.state)) {
        return { ok: true, already: true, state: entry.state };
      }
      try {
        await this.api.stop(entry);
      } catch (error) {
        if (error?.statusCode !== 404) throw translate(error);
      }
      entry.state = "stopped";
      return { ok: true, already: false, state: entry.state };
    });
  }

  /** Idempotent teardown; the record only marks that this process destroyed it. */
  async destroy(computerId, capability, { adopt = false } = {}) {
    const entry = this.#entry(computerId, capability, { allowTerminal: true, adopt });
    return this.#lock(entry.id, async () => {
      if (entry.state === "destroyed") return { ok: true, already: true };
      try {
        await this.api.destroy(entry);
      } catch (error) {
        if (error?.statusCode !== 404) throw translate(error);
      }
      entry.state = "destroyed";
      return { ok: true, already: false };
    });
  }
}
