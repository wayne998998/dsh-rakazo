/**
 * Shared bridge client and computer lifecycle for the dsh-rakazo seam providers
 * (`fs-rakazo.js`, `shell-rakazo.js`).
 *
 * A computer is named `dsh-<scope>`; the scope is the calling session id (or,
 * under `share: true`, its Team root, walked up via `parentSession`), exactly
 * like `plugin/index.js`. `ensureComputer` single-flights creation and caches
 * the capability process-locally per bot identity: the bridge rotates the
 * capability on every `POST /v1/computers` (the last create wins; an earlier
 * capability is invalidated), so a second independent create for the same bot
 * identity would break the first holder. Different identities get different
 * computers; concurrent calls for the SAME identity share one in-flight promise.
 *
 * Secrets are never logged, returned, or compared here; they flow straight into
 * the `authorization` header.
 */
import { readFileSync } from "node:fs";

/** Bridge endpoint fallback, matching plugin/index.js. */
export const DEFAULT_BRIDGE_URL = "http://127.0.0.1:7400";

/** The Rakazo computer's home — the workspace root the bridge serves. */
export const WORKSPACE_ROOT = "/home/rakazo";

/** Rakazo bot identity for one scope key, matching plugin/index.js `botIdFor`. */
export function botIdFor(scope) {
  return `dsh-${scope}`;
}

/** Read `key` from the environment, then from an `envFile` (KEY=value lines). */
export function envValue(key, envFile) {
  if (process.env[key]) return process.env[key];
  if (!envFile) return undefined;
  try {
    const line = readFileSync(envFile, "utf8")
      .split(/\r?\n/)
      .find((value) => value.startsWith(`${key}=`));
    return line?.slice(key.length + 1) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve `{ url, token }` from a provider row `config` (`{ url, token,
 * envFile }`), falling back to `BRIDGE_URL`/`BRIDGE_TOKEN` in the environment
 * and to the `envFile`. Mirrors plugin/index.js `configure()`.
 */
export function resolveConfig(config) {
  const settings = config ?? {};
  const envFile =
    typeof settings.envFile === "string" && settings.envFile
      ? settings.envFile
      : undefined;
  const url =
    (typeof settings.url === "string" && settings.url
      ? settings.url
      : envValue("BRIDGE_URL", envFile)) ?? DEFAULT_BRIDGE_URL;
  const token =
    (typeof settings.token === "string" && settings.token
      ? settings.token
      : undefined) ?? envValue("BRIDGE_TOKEN", envFile);
  return { url: url.replace(/\/$/, ""), token };
}

/**
 * A bridge round-trip that failed. `.status` is the HTTP status (0 for a
 * network failure or a caller abort), `.aborted` is set when the caller's
 * signal fired. Providers map this to their own error taxonomy.
 */
export class BridgeHttpError extends Error {
  constructor(status, message, options) {
    super(message, options);
    this.status = status;
  }
}

/**
 * One HTTP round-trip to the bridge. Returns the parsed JSON body, forwarding
 * `body` (JSON-encoded) and the capability header generically. Throws
 * {@link BridgeHttpError} on non-ok statuses and network/abort failures.
 *
 * @param {string} url - bridge base URL (no trailing slash).
 * @param {string} token - bridge service bearer token.
 * @param {string} path - bridge route, e.g. `/v1/computers`.
 * @param {object} [opts]
 * @param {string} [opts.method] - HTTP method, default GET.
 * @param {unknown} [opts.body] - JSON body.
 * @param {string} [opts.capability] - per-computer capability header.
 * @param {AbortSignal} [opts.signal] - caller cancellation.
 */
export async function bridgeFetch(
  url,
  token,
  path,
  { method = "GET", body, capability, signal } = {},
) {
  if (!token) {
    throw new BridgeHttpError(0, "rakazo bridge token is not configured for this harness");
  }
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (capability) headers.set("x-rakazo-computer-capability", capability);
  if (body !== undefined) headers.set("content-type", "application/json");

  const timeout = AbortSignal.timeout(300_000);
  const fetchSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;

  let response;
  try {
    response = await fetch(`${url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: fetchSignal,
    });
  } catch (cause) {
    if (signal?.aborted) {
      throw new BridgeHttpError(0, "rakazo bridge operation aborted", { cause });
    }
    throw new BridgeHttpError(
      0,
      `rakazo bridge unreachable: ${cause?.message ?? cause}`,
      { cause },
    );
  }

  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { error: text.slice(0, 300) };
  }
  if (!response.ok) {
    throw new BridgeHttpError(
      response.status,
      value.error ?? `rakazo bridge returned ${response.status}`,
    );
  }
  return value;
}

// --- Shared computer lifecycle -------------------------------------------------

/** botId -> { record: {computerId, capability} } | { promise } */
const computers = new Map();

/**
 * Lazily create (or re-adopt) the computer for `botId` and return its cached
 * `{ computerId, capability }`. Creation is single-flighted and promise-cached
 * so every provider in this process shares one live capability for the identity.
 */
export function ensureComputer({ url, token, botId }) {
  const entry = computers.get(botId);
  if (entry?.record) return entry.record;
  if (entry?.promise) return entry.promise;
  const promise = (async () => {
    const created = await bridgeFetch(url, token, "/v1/computers", {
      method: "POST",
      body: { botId },
    });
    const record = { computerId: created.computerId, capability: created.capability };
    computers.set(botId, { record });
    return record;
  })();
  computers.set(botId, { promise });
  return promise;
}

/**
 * Resolve the scope key (Team root) for a session id by walking the parent
 * lineage to the outermost ancestor. Never throws: a missing store or session
 * stops the walk at the deepest id reached, a cycle or an over-long lineage is
 * capped (32 hops), and an unusable `sessionId` is returned unchanged.
 *
 * @param {string} sessionId - the calling session id (e.g. `policy.sessionId`).
 * @param {{ get(id: string): { header?: { parentSession?: string } } | undefined } | undefined} sessions - the live session store.
 * @returns {string} the outermost ancestor id, or `sessionId` when unavailable.
 */
export function scopeKeyFor(sessionId, sessions) {
  let current = sessionId;
  if (typeof current !== "string" || !current) return current;
  const seen = new Set();
  for (let hops = 0; hops < 32; hops += 1) {
    if (seen.has(current)) return current;
    seen.add(current);
    let session;
    try {
      session = sessions?.get?.(current);
    } catch {
      return current;
    }
    if (!session) return current;
    const parent = session?.header?.parentSession;
    if (typeof parent !== "string" || !parent) return current;
    current = parent;
  }
  return current;
}

// --- Path mapping -------------------------------------------------------------

/** Thrown by {@link workspaceRel} when a path leaves the workspace. */
export class WorkspaceEscapeError extends Error {
  constructor(message) {
    super(message);
    this.code = "WORKSPACE_ESCAPE";
  }
}

/**
 * Map a model-supplied path to workspace-relative form (no leading `/`, no `.`
 * or `..` components) so the bridge accepts it. Absolute paths must live under
 * {@link WORKSPACE_ROOT}; a relative path is joined to the workspace-relative
 * `cwd` before normalization. Throws {@link WorkspaceEscapeError} when the path
 * escapes the workspace (an absolute path elsewhere, or a `..` past the root).
 */
export function workspaceRel(path, cwd = "") {
  if (typeof path !== "string") {
    throw new WorkspaceEscapeError("path must be a string");
  }
  const raw = path.replaceAll("\\", "/");
  let joined = raw;
  if (raw.startsWith("/")) {
    if (raw === WORKSPACE_ROOT || raw.startsWith(`${WORKSPACE_ROOT}/`)) {
      joined = raw.slice(WORKSPACE_ROOT.length).replace(/^\/+/, "");
    } else {
      throw new WorkspaceEscapeError(`path "${path}" escapes the Rakazo workspace`);
    }
  } else if (cwd) {
    const base = workspaceRel(cwd);
    joined = base ? `${base}/${raw}` : raw;
  }

  const segments = [];
  for (const segment of joined.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) {
        throw new WorkspaceEscapeError(`path "${path}" escapes the Rakazo workspace`);
      }
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join("/");
}
