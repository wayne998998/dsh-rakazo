/**
 * End-to-end checks for the Rakazo computer-use plugin.
 *
 * Mounts the real tool and computer-use registries with a live bridge, and
 * asserts the contracts the plugin owns rather than its internals:
 *
 * - one computer per scope, with the session-derived identity;
 * - a teammate of a Team shares the Team's computer, and a teammate leaving the
 *   roster neither destroys it nor loses access;
 * - a teammate observes on its own named screen while the principal names none;
 * - workers stay isolated from each other and from another Team;
 * - destroying forgets the id, so a stale id is reported instead of silently
 *   accepted, and disposal releases what a session owned.
 *
 * These are the falsifiable versions: the shared-disposal and screen-naming
 * checks were each proven to fail when their behaviour is broken (see the
 * commit message), so a green run here means something.
 *
 * This suite needs the Harness packages, so it runs from the harness checkout
 * with the bridge's env file in place:
 *
 *   node test/plugin.mjs --harness /path/to/deepseek-harness
 *   DSH_HARNESS=/path/to/deepseek-harness npm run test:plugin
 *
 * `test/bridge.mjs` and `test/screens.mjs` are dependency-free and run with
 * plain `node` from this directory.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Context } from "@deepseek-ai/cordis";
import ComputerUseRegistry from "@deepseek-ai/dsh-computer-use";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

/** The deployment env file: this project's own, overridable for other layouts. */
const bridgeEnvFile = process.env.BRIDGE_ENV_FILE ?? fileURLToPath(new URL("../.env", import.meta.url));
const bridgeToken = /^BRIDGE_TOKEN=(.*)$/m.exec(readFileSync(bridgeEnvFile, "utf8"))?.[1];
if (!bridgeToken) throw new Error("bridge token missing from the bridge env file");

/** The harness checkout to load packages from: `--harness <path>` or `$DSH_HARNESS`. */
const harnessArg = process.argv.indexOf("--harness");
const harnessRoot = harnessArg === -1 ? process.env.DSH_HARNESS : process.argv[harnessArg + 1];
if (!harnessRoot) {
  throw new Error(
    "this suite needs a DeepSeek Harness checkout to resolve its packages; pass --harness <path> or set DSH_HARNESS",
  );
}
const pluginEntry = new URL("../plugin/index.js", import.meta.url).href;
const plugin = await import(pluginEntry);

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`${name}=ok`);
    return;
  }
  failures += 1;
  console.log(`${name}=FAIL ${detail ?? ""}`);
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function liveComputers() {
  const response = await fetch("http://127.0.0.1:7400/v1/computers", {
    headers: { authorization: `Bearer ${bridgeToken}` },
  });
  return (await response.json()).computers ?? [];
}

/** Mount the plugin with the real registries and a session store that answers lineage. */
const sessions = new Map();
async function mount(config) {
  const ctx = new Context();
  await ctx.plugin(SystemPrompt);
  await ctx.plugin(ToolRuntime);
  ctx.provide("attachments", {
    saveImage: async () => ({ attachmentId: "a", mediaType: "image/png", bytes: 1, width: 1, height: 1 }),
  });
  await ctx.plugin(ComputerUseRegistry);
  ctx.provide("sessionQuery", { listSessions: async () => [] });
  // The contractual lineage source: a session store keyed by session id.
  ctx.provide("sessions", {
    get: (id) => sessions.get(id),
  });
  await ctx.plugin(plugin, { envFile: bridgeEnvFile, ...config });
  return ctx;
}

/**
 * A caller as the harness presents one: `agent.session.id` is the identity
 * (`Agent` guarantees only `{ id }`, and the ACP bridge reads `agent.session.id`
 * the same way). Lineage lives in the session store, which is why a session is
 * registered before its agent is used.
 */
function agent(sessionId, parentSession) {
  sessions.set(sessionId, { id: sessionId, header: parentSession ? { parentSession } : {} });
  return { id: sessionId, session: { id: sessionId } };
}
function call(ctx, name, args, sessionId, parentSession) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`${sessionId}:${name}:${Date.now()}:${Math.random()}`),
    name,
    arguments: args,
    agent: agent(sessionId, parentSession),
  });
}
const textOf = (result) => (result.content[0]?.type === "text" ? (result.content[0].text ?? "") : "");

/**
 * Fire `agent/disposed` the way the harness does. Agent disposal is dispatched
 * through the agent's own scope carrier — `dispatch('emit', [carrier, …])` —
 * and the payload carries `{ agent }`. Dispatching with the context as carrier
 * routes the event to the wrong scope, which would leave an agent-scoped
 * listener with no agent and make this check vacuous.
 */
function disposeAgent(ctx, disposedAgent) {
  const args = [disposedAgent, "agent/disposed", { agent: disposedAgent }];
  for (const callback of ctx.events.dispatch("emit", args)) {
    callback(...args);
  }
}

/** Record the screen each call names, then let it run for real. */
function recordScreens() {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("127.0.0.1:7400")) {
      const headers = new Headers(init?.headers);
      sent.push({ path: new URL(url).pathname, screenId: headers.get("x-rakazo-screen-id") ?? undefined });
    }
    return realFetch(input, init);
  };
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}

const stamp = Date.now();
const before = (await liveComputers()).map((entry) => entry.computerId);

// ---- Tools register a merged surface --------------------------------------
const ctx = await mount({});
{
  const names = ctx.tools.schemas().map((schema) => schema.name).sort();
  const expected = [
    "rakazo_computer_browser",
    "rakazo_computer_create",
    "rakazo_computer_destroy",
    "rakazo_computer_exec",
    "rakazo_computer_observe",
    "rakazo_computers",
    "rakazo_file",
  ];
  check("tool surface is the merged seven", JSON.stringify(names) === JSON.stringify(expected), names.join(","));
}

// ---- One computer per session, isolated from another ----------------------
const sessionA = `sess-a-${stamp}`;
const sessionB = `sess-b-${stamp}`;
const createdA = await call(ctx, "rakazo_computer_create", {}, sessionA);
const computerA = JSON.parse(textOf(createdA)).computerId;
check("create returns a computer", typeof computerA === "string", textOf(createdA));
check(
  "identity is the session-derived name",
  (await liveComputers()).some((entry) => entry.computerId === computerA && entry.botId === `dsh-${sessionA}`),
);

const againA = textOf(await call(ctx, "rakazo_computer_create", {}, sessionA));
check(
  "re-creating re-adopts the same computer",
  againA.includes(`"computerId":"${computerA}"`) && againA.includes('"resumed":true'),
  againA,
);

const createdB = await call(ctx, "rakazo_computer_create", {}, sessionB);
const computerB = JSON.parse(textOf(createdB)).computerId;
check("a second session gets its own computer", computerB !== computerA, `${computerA?.slice(0, 8)} vs ${computerB?.slice(0, 8)}`);
check(
  "a session cannot address another session's computer",
  textOf(await call(ctx, "rakazo_computers", { computerId: computerA }, sessionB)).includes("unknown computer in this session"),
);

// ---- Destroy forgets the id ------------------------------------------------
{
  const destroyed = await call(ctx, "rakazo_computer_destroy", { computerId: computerB }, sessionB);
  check("destroy succeeds", !destroyed.isError, textOf(destroyed));
  const again = await call(ctx, "rakazo_computer_destroy", { computerId: computerB }, sessionB);
  check(
    "a forgotten id is reported, not silently accepted",
    again.isError && textOf(again).includes("unknown computer in this session"),
    textOf(again).slice(0, 90),
  );
  const gone = !(await liveComputers()).some((entry) => entry.computerId === computerB);
  check("the destroyed computer left the bridge", gone);
}

await ctx.fiber.dispose();

// ---- Shared mode: teammates share one computer -----------------------------
const team = `team-${stamp}`;
const member1 = `${team}-m1`;
const member2 = `${team}-m2`;
{
  const shared = await mount({ share: true });
  const created = textOf(await call(shared, "rakazo_computer_create", {}, team));
  const computer = JSON.parse(created).computerId;
  check("the Team lead created a computer", typeof computer === "string", created);

  check(
    "a teammate resolves to the Team's computer",
    textOf(await call(shared, "rakazo_computers", {}, member1, team)).includes(computer),
  );

  // A teammate names its own screen; the lead names none.
  const recorder = recordScreens();
  await call(shared, "rakazo_computer_observe", { computerId: computer }, member1, team);
  const memberScreen = recorder.sent.find((entry) => entry.path.endsWith("/observe"))?.screenId;
  check("a teammate observes on its own named screen", memberScreen === `dsh-${team}-${member1}`, String(memberScreen));
  recorder.sent.length = 0;
  await call(shared, "rakazo_computer_observe", { computerId: computer }, team);
  const leadScreen = recorder.sent.find((entry) => entry.path.endsWith("/observe"))?.screenId;
  check("the lead observes on the computer's own screen", leadScreen === undefined, String(leadScreen));
  recorder.restore();

  // A teammate leaving must not end the Team's computer. Dispose through the
  // same dispatcher the harness uses (`ctx.events.dispatch('emit', …)` on the
  // agent's carrier); a plain `ctx.emit` does not reach a plugin's `ctx.on`
  // listener, which would make this check vacuous.
  disposeAgent(shared, agent(member1, team));
  await delay(2_000);
  check(
    "a teammate's disposal leaves the shared computer running",
    (await liveComputers()).some((entry) => entry.computerId === computer),
  );
  check(
    "another teammate still works after a peer left",
    !(await call(shared, "rakazo_computers", {}, member2, team)).isError,
  );

  // The lead's disposal is what ends it.
  disposeAgent(shared, agent(team));
  let ended = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !ended) {
    ended = !(await liveComputers()).some((entry) => entry.computerId === computer);
    if (!ended) await delay(500);
  }
  check("the lead's disposal ends the shared computer", ended);
  await shared.fiber.dispose();
}

// ---- Disposal releases what a session owned -------------------------------
{
  const solo = await mount({});
  const session = `solo-${stamp}`;
  const created = JSON.parse(textOf(await call(solo, "rakazo_computer_create", {}, session))).computerId;
  await solo.fiber.dispose();
  let released = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !released) {
    released = !(await liveComputers()).some((entry) => entry.computerId === created);
    if (!released) await delay(500);
  }
  check("disposal destroys the session's computer", released);
}

// ---- Cleanup ---------------------------------------------------------------
const leftover = (await liveComputers()).filter((entry) => !before.includes(entry.computerId));
for (const entry of leftover) {
  await fetch(`http://127.0.0.1:7400/v1/computers/${entry.computerId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bridgeToken}`, "x-rakazo-adopt": "1" },
  }).catch(() => undefined);
}
const remaining = (await liveComputers()).filter((entry) => !before.includes(entry.computerId));
check("no computers left behind", remaining.length === 0, JSON.stringify(remaining));

console.log(failures === 0 ? "plugin checks: all passed" : `plugin checks: ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
