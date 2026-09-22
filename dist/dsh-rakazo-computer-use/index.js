/**
 * Rakazo computer use for DeepSeek Harness.
 *
 * Registers the `rakazo` computer-use provider and the tools that drive one
 * disposable Rakazo Docker computer per Agent session:
 *
 * - Ownership is per session. A computer is reachable only through the
 *   capability this process holds for it, and only from the session that
 *   created it, so naming another session's computer cannot reach it.
 * - The bridge issues the computer identity; the model never chooses it.
 * - Disposing an Agent destroys that session's computers, so a closed
 *   conversation does not leak a running container.
 *
 * The bridge endpoint and credential come from this plugin row's `config`
 * (`{ url, token, envFile }`), falling back to `BRIDGE_URL`/`BRIDGE_TOKEN` in
 * the environment. `envFile` lets a development deployment read a local
 * bridge's `.env`; an installed deployment configures the row instead. The
 * model never sees the token.
 */
import { readFileSync } from "node:fs";

export const name = "rakazo-computer-use";

/** Services this plugin needs before it can register anything. */
export const inject = ["tools", "attachments"];

/** Bridge connection resolved once per mounted plugin instance. */
let bridgeUrl = "http://127.0.0.1:7400";
let bridgeToken;
/** When set, disposal forgets a computer instead of destroying it. */
let keepComputers = false;
/** When set, every teammate of one Team shares that Team's computer. */
let shareComputers = false;

function envValue(key, envFile) {
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

/** Resolve the bridge endpoint from the row config, then the environment. */
function configure(config) {
  const settings = config ?? {};
  const envFile = typeof settings.envFile === "string" && settings.envFile ? settings.envFile : undefined;
  const url = typeof settings.url === "string" && settings.url ? settings.url : envValue("BRIDGE_URL", envFile);
  bridgeUrl = (url ?? "http://127.0.0.1:7400").replace(/\/$/, "");
  bridgeToken = (typeof settings.token === "string" && settings.token ? settings.token : undefined) ?? envValue("BRIDGE_TOKEN", envFile);
  keepComputers = settings.keep === true;
  shareComputers = settings.share === true;
}

/** sessionId -> Map(computerId -> capability). Process-local, never persisted by the harness. */
const owned = new Map();

/**
 * The computer a conversation works on.
 *
 * With `share: true` every teammate of one Team uses the same computer, the way
 * a shared team computer works: a teammate is a child session, so the root of
 * the lineage is the Team, and the identity becomes that root. This is a
 * deliberate trade — teammates can then read each other's files and browser
 * sessions — so it is opt-in per deployment and the isolation default is
 * unchanged.
 *
 * Identity comes from `agent.session.id`, the harness convention the ACP bridge
 * also relies on (`Agent` itself guarantees only `{ id }`). Lineage comes from
 * `agent.session.header.parentSession` when present, else from the session store
 * through the sessions service, which is the contractual source.
 *
 * The fallback matters: an unresolved lineage would silently collapse every
 * caller onto one unrelated scope — and, because the same value keys ownership,
 * a release would then dispose nothing. So a scope that cannot be established
 * from any source is reported instead of guessed.
 */
function scopeKeyOf(agent, ctx, { optional = false } = {}) {
  const own = typeof agent?.session?.id === "string" && agent.session.id
    ? agent.session.id
    : typeof agent?.id === "string" && agent.id
      ? agent.id
      : undefined;
  if (!own) {
    if (optional) return undefined;
    throw new Error("rakazo: this tool call has no session identity to scope a computer to");
  }
  if (!shareComputers) return own;
  const inline = agent?.session?.header?.parentSession;
  if (typeof inline === "string" && inline) return inline;
  const stored = ctx?.get?.("sessions")?.get?.(own)?.header?.parentSession;
  return typeof stored === "string" && stored ? stored : own;
}

/** Every computer this plugin owns is named `dsh-<scope>`; nothing else is ours. */
const BOT_ID_PREFIX = "dsh-";

/**
 * The display this caller should use, when screens are shared.
 *
 * Rakazo namespaces a screen under the computer's own botId, so a member's
 * screen is `<botId>-<member>`: unique per teammate, still provably owned by
 * this computer, and therefore legitimate for the external API to accept. The
 * principal keeps the computer's own screen, so a single-agent conversation is
 * unchanged. Without sharing there is one screen per computer and no name is
 * needed.
 */
function screenIdFor(agent, scopeKey, computerBotId) {
  if (!shareComputers) return undefined;
  const own = typeof agent?.session?.id === "string" ? agent.session.id : undefined;
  if (!own || own === scopeKey) return undefined;
  return `${computerBotId}-${own}`;
}

/** Rakazo bot identity for one scope: deterministic, never model-chosen. */
function botIdFor(scopeKey) {
  return `${BOT_ID_PREFIX}${scopeKey}`;
}

function sessionComputers(scopeKey) {
  let computers = owned.get(scopeKey);
  if (!computers) {
    computers = new Map();
    owned.set(scopeKey, computers);
  }
  return computers;
}

async function bridge(path, { method = "GET", body, capability, adopt = false, screenId } = {}) {
  if (!bridgeToken) throw new Error("rakazo bridge token is not configured for this harness");
  const headers = new Headers({ authorization: `Bearer ${bridgeToken}` });
  if (capability) headers.set("x-rakazo-computer-capability", capability);
  // Names this caller's own display on a shared computer; Rakazo rejects any
  // name outside the computer this capability belongs to.
  if (screenId) headers.set("x-rakazo-screen-id", screenId);
  // Pruning addresses computers this process never issued a capability for, so
  // it asks the bridge to treat its own returned list as the authority.
  if (adopt) headers.set("x-rakazo-adopt", "1");
  if (body !== undefined) headers.set("content-type", "application/json");
  let response;
  try {
    response = await fetch(`${bridgeUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
  } catch (cause) {
    throw new Error(`rakazo bridge unreachable: ${cause?.message ?? cause}`);
  }
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { error: text.slice(0, 300) };
  }
  if (!response.ok) throw new Error(value.error ?? `rakazo bridge returned ${response.status}`);
  return value;
}

/** Resolve this session's capability for a computer, refusing anyone else's. */
function capabilityFor(scopeKey, computerId) {
  if (typeof computerId !== "string" || !computerId) throw new Error("computerId is required");
  const capability = owned.get(scopeKey)?.get(computerId);
  if (!capability) {
    throw new Error(
      `unknown computer in this session: ${computerId}. Use a computerId returned by rakazo_computer_create here, or list them with rakazo_computers.`,
    );
  }
  return capability;
}

function text(value) {
  return [{ type: "text", text: JSON.stringify(value) }];
}

/**
 * Forget one computer's scope. By default the computer is destroyed, so a closed
 * conversation leaves no container running; `keep: true` makes disposal only
 * forget it, so the same identity re-adopts it later.
 *
 * In shared mode a teammate's scope is its Team's root session, so a teammate
 * disposing would otherwise destroy the computer its teammates are still using.
 * The Lead's own disposal is the one that ends the Team, which is why only the
 * scope owner releases; a teammate's `agent/disposed` must not.
 */
async function releaseSession(scopeKey, { principal = false } = {}) {
  const computers = owned.get(scopeKey);
  if (!computers) return;
  // Only a principal ends a shared computer. A teammate's scope resolves to the
  // Team root, so an identity comparison cannot distinguish them — the caller's
  // `principal` judgement is the only signal, and it must be the sole gate.
  if (shareComputers && !principal) return;
  owned.delete(scopeKey);
  if (keepComputers) return;
  for (const [computerId, capability] of computers) {
    await bridge(`/v1/computers/${encodeURIComponent(computerId)}`, { method: "DELETE", capability }).catch(() => undefined);
  }
}

function computerTools(ctx) {
  const computerPath = (computerId) => encodeURIComponent(computerId);

  return [
    {
      name: "rakazo_computer_create",
      description:
        "Create and start one disposable Linux desktop computer for this conversation. Returns its computerId, which every other rakazo_* tool needs. Call it once and keep the id; the bridge decides the computer's identity, so never invent or reuse an id. The computer is destroyed automatically when this conversation is disposed.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      output: {
        schema: { type: "object", properties: { computerId: { type: "string" } }, required: ["computerId"] },
        render: (_args, value) => text(value),
      },
      async execute(_args, exec) {
        const scopeKey = scopeKeyOf(exec.agent, ctx);
        // Identity is derived from the session, never chosen by the model, so
        // the same conversation re-adopts the same computer after a restart.
        const created = await bridge("/v1/computers", { method: "POST", body: { botId: botIdFor(scopeKey) } });
        if (typeof created.computerId !== "string") throw new Error("rakazo bridge returned no computer id");
        sessionComputers(scopeKey).set(created.computerId, created.capability);
        return { computerId: created.computerId, resumed: created.resumed === true };
      },
    },
    {
      name: "rakazo_computers",
      description:
        "Without computerId, list the Rakazo computers this conversation created. With computerId, report whether that one is still running — do this after a failed or cancelled action before deciding what to do next. Use it to recover an id you no longer have in context instead of guessing one.",
      parameters: {
        type: "object",
        properties: {
          computerId: { type: "string", description: "Optional id returned by rakazo_computer_create." },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: "object",
          properties: {
            computers: {
              type: "array",
              items: {
                type: "object",
                properties: { computerId: { type: "string" }, state: { type: "string" } },
                required: ["computerId", "state"],
              },
            },
            computerId: { type: "string" },
            running: { type: "boolean" },
            state: { type: "string" },
          },
        },
        render: (_args, value) => text(value),
      },
      async execute(args, exec) {
        const scopeKey = scopeKeyOf(exec.agent, ctx);
        if (args.computerId !== undefined) {
          const capability = capabilityFor(scopeKey, args.computerId);
          return bridge(`/v1/computers/${computerPath(args.computerId)}`, { capability });
        }
        const mine = owned.get(scopeKey) ?? new Map();
        const listed = await bridge("/v1/computers");
        const computers = (listed.computers ?? [])
          .filter((entry) => mine.has(entry.computerId))
          .map((entry) => ({ computerId: entry.computerId, state: entry.state }));
        return { computers };
      },
    },
    {
      name: "rakazo_computer_exec",
      description:
        "Run one command inside the Rakazo computer workspace (argv form, no shell interpolation) and return stdout, stderr, and the exit code. A non-zero exit is a result: read the code. If a command times out or is cancelled it may still have taken effect, so inspect the workspace before repeating it and never replay a destructive command blindly.",
      parameters: {
        type: "object",
        properties: {
          computerId: { type: "string" },
          argv: {
            type: "array",
            items: { type: "string" },
            description: 'Program and arguments, for example ["bash","-lc","ls -la"].',
          },
          cwd: { type: "string", description: "Workspace-relative directory; defaults to the workspace root." },
          timeoutMs: { type: "integer", minimum: 1000, maximum: 300000 },
        },
        required: ["computerId", "argv"],
      },
      output: {
        schema: {
          type: "object",
          properties: {
            stdout: { type: "string" },
            stderr: { type: "string" },
            code: { type: "integer" },
          },
          required: ["stdout", "stderr", "code"],
        },
        render: (_args, value) => text(value),
      },
      execute(args, exec) {
        const scopeKey = scopeKeyOf(exec.agent, ctx);
        const capability = capabilityFor(scopeKey, args.computerId);
        return bridge(`/v1/computers/${computerPath(args.computerId)}/exec`, {
          method: "POST",
          capability,
          body: { argv: args.argv, cwd: args.cwd, timeoutMs: args.timeoutMs },
        });
      },
    },
    {
      name: "rakazo_file",
      description:
        "Read or write one UTF-8 text file in the Rakazo computer workspace. `read` returns its contents; `write` creates parent directories as needed and replaces the file.",
      parameters: {
        type: "object",
        properties: {
          computerId: { type: "string" },
          op: { type: "string", enum: ["read", "write"] },
          path: { type: "string", description: "Workspace-relative path; parent traversal is rejected." },
          content: { type: "string", description: "Required for op=write." },
          executable: { type: "boolean", description: "Optional for op=write." },
        },
        required: ["computerId", "op", "path"],
      },
      output: {
        schema: {
          type: "object",
          properties: { content: { type: "string" }, ok: { type: "boolean" } },
        },
        render: (_args, value) => text(value),
      },
      async execute(args, exec) {
        const scopeKey = scopeKeyOf(exec.agent, ctx);
        const capability = capabilityFor(scopeKey, args.computerId);
        if (args.op === "read") {
          const value = await bridge(
            `/v1/computers/${computerPath(args.computerId)}/files/read?path=${encodeURIComponent(args.path ?? "")}`,
            { capability },
          );
          return { content: Buffer.from(value.content ?? "", "base64").toString("utf8") };
        }
        if (args.op !== "write") throw new Error("op must be read or write");
        if (typeof args.content !== "string") throw new Error("content is required for op=write");
        await bridge(`/v1/computers/${computerPath(args.computerId)}/files/write`, {
          method: "POST",
          capability,
          body: { path: args.path, content: args.content, executable: args.executable },
        });
        return { ok: true };
      },
    },
    {
      name: "rakazo_computer_observe",
      description:
        "Take a fresh screenshot of the Rakazo computer's desktop and return it as an image. Observe before and after any desktop interaction, because a delivered click does not prove the intended outcome.",
      parameters: {
        type: "object",
        properties: { computerId: { type: "string" } },
        required: ["computerId"],
      },
      output: {
        schema: {
          type: "object",
          properties: {
            mediaType: { type: "string" },
            width: { type: "integer" },
            height: { type: "integer" },
            attachment: {
              type: "object",
              properties: {
                attachmentId: { type: "string" },
                mediaType: { type: "string" },
                bytes: { type: "integer" },
                width: { type: "integer" },
                height: { type: "integer" },
              },
              required: ["attachmentId", "mediaType", "bytes", "width", "height"],
            },
          },
          required: ["mediaType", "width", "height", "attachment"],
        },
        render: (_args, value) => [
          { type: "image", attachment: value.attachment },
          ...text({ width: value.width, height: value.height }),
        ],
      },
      async execute(args, exec) {
        const scopeKey = scopeKeyOf(exec.agent, ctx);
        const capability = capabilityFor(scopeKey, args.computerId);
        const observed = await bridge(`/v1/computers/${computerPath(args.computerId)}/observe`, {
          method: "POST",
          capability,
          screenId: screenIdFor(exec.agent, scopeKey, botIdFor(scopeKey)),
        });
        const attachment = await ctx.attachments.saveImage({
          data: Buffer.from(observed.image ?? "", "base64"),
          mediaType: observed.mimeType,
          name: `rakazo-computer-${String(args.computerId).slice(0, 12)}.png`,
        });
        return {
          mediaType: observed.mimeType,
          width: observed.width,
          height: observed.height,
          attachment: {
            attachmentId: attachment.attachmentId,
            mediaType: attachment.mediaType,
            bytes: attachment.bytes,
            width: attachment.width,
            height: attachment.height,
          },
        };
      },
    },
    {
      name: "rakazo_computer_browser",
      description:
        "Drive the Rakazo computer's browser: navigate to a URL, read a page snapshot with element references, or act on that snapshot. Re-snapshot after acting; a failed action may have partially applied and must be inspected, never replayed automatically.",
      parameters: {
        type: "object",
        properties: {
          computerId: { type: "string" },
          command: { type: "string", enum: ["navigate", "snapshot", "act"] },
          url: { type: "string", description: "Required for navigate." },
          actions: { type: "array", description: "Required for act." },
        },
        required: ["computerId", "command"],
      },
      output: {
        schema: {
          type: "object",
          properties: {
            ok: { type: "boolean" },
            url: { type: "string" },
            title: { type: "string" },
            tree: { type: "string" },
            elements: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  role: { type: "string" },
                  name: { type: "string" },
                  value: { type: "string" },
                },
                required: ["ref", "role", "name"],
              },
            },
            completed: { type: "integer" },
            uncertain: { type: "boolean" },
            fallback: { type: "string" },
            error: { type: "string" },
          },
          required: ["ok"],
        },
        render: (_args, value) => text(value),
      },
      async execute(args, exec) {
        const scopeKey = scopeKeyOf(exec.agent, ctx);
        const capability = capabilityFor(scopeKey, args.computerId);
        const result = await bridge(`/v1/computers/${computerPath(args.computerId)}/browser`, {
          method: "POST",
          capability,
          body: { command: args.command, url: args.url, actions: args.actions },
          screenId: screenIdFor(exec.agent, scopeKey, botIdFor(scopeKey)),
        });
        // The page helper's whole value is the tree and the element refs that
        // browser_act needs, so pass them through instead of collapsing to ok.
        return {
          ok: result?.ok !== false,
          ...(typeof result?.url === "string" ? { url: result.url } : {}),
          ...(typeof result?.title === "string" ? { title: result.title } : {}),
          ...(typeof result?.tree === "string" ? { tree: result.tree } : {}),
          ...(Array.isArray(result?.elements)
            ? {
                elements: result.elements.map((element) => ({
                  ref: String(element?.ref ?? ""),
                  role: String(element?.role ?? ""),
                  name: String(element?.name ?? ""),
                  ...(typeof element?.value === "string" ? { value: element.value } : {}),
                })),
              }
            : {}),
          ...(Number.isInteger(result?.completed) ? { completed: result.completed } : {}),
          ...(result?.uncertain === true ? { uncertain: true } : {}),
          ...(typeof result?.fallback === "string" ? { fallback: result.fallback } : {}),
          ...(typeof result?.error === "string" ? { error: result.error } : {}),
        };
      },
    },
    {
      name: "rakazo_computer_destroy",
      description:
        "Stop and delete a Rakazo computer from this conversation, releasing its resources. Idempotent. Do this when the task is finished or the computer is no longer needed; the provider also does it when the conversation is disposed.",
      parameters: {
        type: "object",
        properties: { computerId: { type: "string" } },
        required: ["computerId"],
      },
      output: {
        schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
        render: (_args, value) => text(value),
      },
      async execute(args, exec) {
        const scopeKey = scopeKeyOf(exec.agent, ctx);
        const capability = capabilityFor(scopeKey, args.computerId);
        try {
          await bridge(`/v1/computers/${computerPath(args.computerId)}`, { method: "DELETE", capability });
        } finally {
          // Forget it even when the bridge refused, so a stale id never lingers
          // as an addressable computer in this session.
          owned.get(scopeKey)?.delete(args.computerId);
        }
        return { ok: true };
      },
    },
  ];
}

export function apply(ctx, config) {
  configure(config);

  // Reserve the exclusive computer-use provider slot when the registry is
  // composed. The web profile does not mount it by default, so the tools stay
  // usable either way and the reservation is released with this plugin.
  ctx.effect(() => {
    const registry = ctx.get("computerUse");
    const release = registry?.register?.("rakazo");
    return async () => {
      await release?.();
    };
  }, "rakazo-computer-use.provider");

  for (const definition of computerTools(ctx)) ctx.tools.register(definition);

  // A closed conversation must not leave a container running. In shared mode
  // only the principal (Lead) ends the Team's computer: a teammate disposing is
  // an ordinary roster change, not the end of the shared workspace.
  ctx.on("agent/disposed", ({ agent }) => {
    // A disposal event without a session identity carries nothing this plugin
    // owns, so it is skipped rather than reported: unlike a tool call, there is
    // no caller to fail. The scope lookup returns undefined in that case.
    const scopeKey = scopeKeyOf(agent, ctx, { optional: true });
    if (!scopeKey) return;
    const isPrincipal = agent?.session?.header?.parentSession === undefined
      && ctx?.get?.("sessions")?.get?.(agent?.session?.id ?? agent?.id)?.header?.parentSession === undefined;
    void releaseSession(scopeKey, { principal: isPrincipal }).catch((error) =>
      console.error(`rakazo-computer-use release failed: ${error?.message ?? error}`),
    );
  });

  // Identity is re-derived from the session, so a crashed or restarted harness
  // re-adopts its computers on the next create instead of holding a lease for
  // them. Nothing here needs a timer.
  //
  // What a crashed harness can leave behind is a computer whose session no
  // longer exists. Reclaim those once at load, from the bridge's own list, and
  // only when this deployment can actually enumerate sessions.
  ctx.effect(() => {
    if (ctx.get("computerUse") === undefined) return;
    void pruneAbandoned(ctx).catch((error) =>
      console.error(`rakazo-computer-use prune failed: ${error?.message ?? error}`),
    );
  }, "rakazo-computer-use.prune");

  // Disposal must finish the teardown it starts, so the disposer awaits it.
  ctx.effect(() => async () => {
    for (const scopeKey of [...owned.keys()]) await releaseSession(scopeKey);
  }, "rakazo-computer-use.release");
}

/**
 * Destroy computers whose owning session no longer exists. A computer is only
 * ever adopted by a session whose id matches its botId, so a `dsh-` computer
 * with no such session can never be reached again; this reclaims its resources
 * rather than leaving a container running until the provider reclaims it.
 */
async function pruneAbandoned(ctx) {
  const sessionQuery = ctx.get("sessionQuery");
  if (!sessionQuery?.listSessions) {
    // Not a failure: a composition without a session store simply cannot prove a
    // computer is abandoned, and killing a live session's computer would be far
    // worse than leaving one for the provider to suspend.
    console.log("rakazo-computer-use prune skipped: no sessionQuery service in this composition");
    return;
  }
  // `live` holds full identities, so compare against the full identity: an
  // earlier version sliced the prefix off here and tested against a set of
  // complete names, which never matched and would have destroyed every live
  // session's computer on load.
  const live = new Set((await sessionQuery.listSessions()).map((record) => `${BOT_ID_PREFIX}${record.id}`));
  const listed = await bridge("/v1/computers");
  const abandoned = (listed.computers ?? []).filter(
    (entry) =>
      typeof entry?.botId === "string" &&
      entry.botId.startsWith(BOT_ID_PREFIX) &&
      !live.has(entry.botId),
  );
  for (const entry of abandoned) {
    // No capability survives from the dead process; the bridge's own list is the
    // authority that these computers belong to this deployment.
    await bridge(`/v1/computers/${encodeURIComponent(entry.computerId)}`, { method: "DELETE", adopt: true }).catch(
      (error) => console.error(`rakazo-computer-use prune failed for ${entry.computerId}: ${error?.message ?? error}`),
    );
  }
  if (abandoned.length) {
    console.log(`rakazo-computer-use pruned ${abandoned.length} abandoned computer(s)`);
  }
}
