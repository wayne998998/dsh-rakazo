/**
 * Account-mode checks: one persistent computer shared by every conversation.
 *
 * This is the widest sharing the plugin offers, so the properties to hold are
 * the ones that make it usable and safe rather than convenient:
 *
 * - two unrelated conversations reach the same machine, and a file one writes
 *   the other can read;
 * - the machine survives every conversation being disposed, because it is meant
 *   to outlive them;
 * - each conversation gets its own screen, so they do not fight over one
 *   display;
 * - an explicit destroy still ends it.
 *
 * Isolation is deliberately absent here, so it is not asserted. What is asserted
 * is that the absence is complete and predictable, which is what makes it a
 * documented trade-off rather than an accident.
 */
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { Context } from "@deepseek-ai/cordis";
import ComputerUseRegistry from "@deepseek-ai/dsh-computer-use";
import { ToolCallId } from "@deepseek-ai/dsh-llm";
import SystemPrompt from "@deepseek-ai/dsh-system-prompt";
import ToolRuntime from "@deepseek-ai/dsh-tools";

const bridgeEnvFile = process.env.BRIDGE_ENV_FILE ?? fileURLToPath(new URL("../.env", import.meta.url));
const bridgeToken = /^BRIDGE_TOKEN=(.*)$/m.exec(readFileSync(bridgeEnvFile, "utf8"))?.[1];
if (!bridgeToken) throw new Error("bridge token missing from the bridge env file");

const plugin = await import(new URL("../plugin/index.js", import.meta.url).href);

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

/** Sessions answer lineage; accounts do not consult it at all. */
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
  ctx.provide("sessions", { get: (id) => sessions.get(id) });
  await ctx.plugin(plugin, { envFile: bridgeEnvFile, ...config });
  return ctx;
}
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

/** Record each call's screen name, then let it run for real. */
function recordScreens() {
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("127.0.0.1:7400")) {
      sent.push({ path: new URL(url).pathname, screenId: new Headers(init?.headers).get("x-rakazo-screen-id") ?? undefined });
    }
    return realFetch(input, init);
  };
  return { sent, restore: () => { globalThis.fetch = realFetch; } };
}

const account = `acct-${Date.now()}`;
const ctx = await mount({ account });
check("account deployment mounts", ctx.tools.schemas().length === 7, `tools=${ctx.tools.schemas().length}`);

// ---- Two unrelated conversations reach one machine ------------------------
const sessionA = `conv-a-${Date.now()}`;
const sessionB = `conv-b-${Date.now()}`;
const createdA = textOf(await call(ctx, "rakazo_computer_create", {}, sessionA));
const computerA = JSON.parse(createdA).computerId;
check("the first conversation creates the account computer", typeof computerA === "string", createdA);
check(
  "its identity is the account name",
  (await liveComputers()).some((entry) => entry.computerId === computerA && entry.botId === `dsh-${account}`),
);

const createdB = textOf(await call(ctx, "rakazo_computer_create", {}, sessionB));
const computerB = JSON.parse(createdB).computerId;
check("an unrelated conversation reaches the same machine", computerB === computerA, `${computerA?.slice(0, 8)} vs ${computerB?.slice(0, 8)}`);
check("and re-adopts rather than recreates", createdB.includes('"resumed":true'), createdB);

// The sharing is real: a file one writes is readable by the other.
const path = `account/shared-${Date.now()}.txt`;
await call(ctx, "rakazo_file", { computerId: computerA, op: "write", path, content: "written-by-a" }, sessionA);
const readByB = textOf(await call(ctx, "rakazo_file", { computerId: computerB, op: "read", path }, sessionB));
check("files are shared across conversations", readByB.includes("written-by-a"), readByB.slice(0, 80));

// ---- Each conversation gets its own screen --------------------------------
const recorder = recordScreens();
await call(ctx, "rakazo_computer_observe", { computerId: computerA }, sessionA);
await call(ctx, "rakazo_computer_observe", { computerId: computerB }, sessionB);
const screens = recorder.sent.filter((entry) => entry.path.endsWith("/observe")).map((entry) => entry.screenId);
recorder.restore();
check(
  "each conversation observes on its own screen",
  screens.length === 2 && screens[0] !== screens[1] && screens.every((s) => s?.startsWith(`dsh-${account}-`)),
  JSON.stringify(screens),
);

// ---- The machine outlives every conversation ------------------------------
ctx.emit("agent/disposed", { agent: agent(sessionA) });
ctx.emit("agent/disposed", { agent: agent(sessionB) });
await delay(2_500);
check(
  "disposing a conversation does not end the account computer",
  (await liveComputers()).some((entry) => entry.computerId === computerA),
);

await ctx.fiber.dispose();
await delay(1_000);
check(
  "unloading the plugin does not end the account computer",
  (await liveComputers()).some((entry) => entry.computerId === computerA),
);

// ---- An explicit destroy still ends it ------------------------------------
const next = await mount({ account });
const adopted = JSON.parse(textOf(await call(next, "rakazo_computer_create", {}, `conv-c-${Date.now()}`))).computerId;
check("a later conversation re-adopts it", adopted === computerA, `${adopted?.slice(0, 8)} vs ${computerA?.slice(0, 8)}`);
const destroyed = await call(next, "rakazo_computer_destroy", { computerId: adopted }, `conv-c-${Date.now()}`);
check("an explicit destroy succeeds", !destroyed.isError, textOf(destroyed));
let gone = false;
const deadline = Date.now() + 20_000;
while (Date.now() < deadline && !gone) {
  gone = !(await liveComputers()).some((entry) => entry.computerId === computerA);
  if (!gone) await delay(500);
}
check("the account computer is gone after destroy", gone);
await next.fiber.dispose();

// ---- Cleanup --------------------------------------------------------------
for (const entry of await liveComputers()) {
  await fetch(`http://127.0.0.1:7400/v1/computers/${entry.computerId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${bridgeToken}`, "x-rakazo-adopt": "1" },
  }).catch(() => undefined);
}
check("no computers left behind", (await liveComputers()).length === 0, JSON.stringify(await liveComputers()));

console.log(failures === 0 ? "account checks: all passed" : `account checks: ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
