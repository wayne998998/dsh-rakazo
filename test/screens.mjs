/**
 * End-to-end checks for computer screens on a shared computer.
 *
 * Rakazo keys a display by a screen identity, so one computer can serve one
 * screen per caller. These checks run against a live bridge, Rakazo API, and
 * real containers, and they assert at the container: a socket in
 * `/tmp/.X11-unix` is what a screen actually costs, while an HTTP 200 proves
 * only that a request was accepted.
 *
 * Every assertion here is falsifiable by construction. The counts are measured
 * against a real baseline rather than assumed: a container carries one socket
 * before anything observes, so N named screens produce `baseline + N - 1`
 * sockets (the first adopts the existing one).
 *
 * The runner reaches Docker through `newgrp docker` because this account is not
 * in the docker group; docker operations no-op to an empty result on failure,
 * which the "container is gone" style assertions treat as "not gone" so a
 * broken host cannot silently satisfy them.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadBridgeClientConfig } from "../src/config.mjs";

const { url, token } = loadBridgeClientConfig();
const service = { authorization: `Bearer ${token}` };
/** The Rakazo deployment's env file; override when it lives elsewhere. */
const rakazoEnvFile = process.env.RAKAZO_ENV_FILE ?? "/home/ic/rakazo/.env";
const apiToken = process.env.EXTERNAL_COMPUTER_TOKEN
  ?? /^EXTERNAL_COMPUTER_TOKEN=(.*)$/m.exec(readFileSync(rakazoEnvFile, "utf8"))?.[1];
if (!apiToken) throw new Error(`EXTERNAL_COMPUTER_TOKEN missing (set it, or point RAKAZO_ENV_FILE at a Rakazo .env): ${rakazoEnvFile}`);

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

async function request(path, { method = "GET", capability, screenId, body, adopt = false, service: withService = true } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(withService ? service : {}),
      ...(capability ? { "x-rakazo-computer-capability": capability } : {}),
      ...(screenId ? { "x-rakazo-screen-id": screenId } : {}),
      ...(adopt ? { "x-rakazo-adopt": "1" } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let value;
  try {
    value = text ? JSON.parse(text) : {};
  } catch {
    value = { error: text.slice(0, 200) };
  }
  return { status: response.status, value };
}

/** Run a command in the docker group, returning "" when it cannot run at all. */
function dockerShell(command) {
  try {
    return execSync(`newgrp docker -c ${JSON.stringify(command)}`, { encoding: "utf8", shell: "/bin/bash" });
  } catch {
    return "";
  }
}
const containerName = (botId) => `rakazo-bot-${botId}`;
function containerExists(botId) {
  const out = dockerShell(`docker ps -a --format '{{.Names}}' | grep -x ${JSON.stringify(containerName(botId))} || true`);
  return out.trim().length > 0;
}
function displays(botId) {
  if (!containerExists(botId)) return [];
  const out = dockerShell(`docker exec ${containerName(botId)} bash -lc 'ls /tmp/.X11-unix 2>/dev/null'`);
  return out.split("\n").map((line) => line.trim()).filter(Boolean);
}
/** Poll, so asynchronous display startup is not read as a cap reusing slots. */
async function displaysUntil(botId, atLeast, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = displays(botId);
  while (seen.length < atLeast && Date.now() < deadline) {
    await delay(1_000);
    seen = displays(botId);
  }
  return seen;
}

async function createComputer(botId) {
  const created = await request("/v1/computers", { method: "POST", body: { botId } });
  if (typeof created.value?.computerId !== "string") {
    throw new Error(`create failed for ${botId}: ${created.status} ${JSON.stringify(created.value)}`);
  }
  return created.value;
}
async function destroyComputer(computerId, capability) {
  return request(`/v1/computers/${computerId}`, { method: "DELETE", capability });
}

const stamp = Date.now();
const created = [];

// ---- A screen name outside the caller's computer is refused ---------------
// The rule is a namespacing one, so the useful case pairs a caller's own botId
// with a screen that belongs to a different computer.
{
  const botId = `dsh-screen-rule-${stamp}`;
  const mine = await createComputer(botId);
  created.push({ botId, ...mine });
  const foreign = await fetch(`http://127.0.0.1:3100/api/v1/external/computers/${mine.computerId}/observe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiToken}`,
      "x-rakazo-bot-id": botId,
      "x-rakazo-screen-id": `dsh-somewhere-else-${stamp}`,
    },
  });
  const body = await foreign.text();
  check(
    "foreign screen name refused",
    foreign.status === 403 && body.includes("does not belong to this computer"),
    `status=${foreign.status} body=${body.slice(0, 120)}`,
  );
  const malformed = await fetch(`http://127.0.0.1:3100/api/v1/external/computers/${mine.computerId}/observe`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "x-rakazo-bot-id": botId, "x-rakazo-screen-id": "bad/slash" },
  });
  check("malformed screen name rejected", malformed.status === 400, `status=${malformed.status}`);
  const legal = await fetch(`http://127.0.0.1:3100/api/v1/external/computers/${mine.computerId}/observe`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiToken}`, "x-rakazo-bot-id": botId, "x-rakazo-screen-id": `${botId}-member` },
  });
  check("own namespaced screen accepted", legal.status === 200, `status=${legal.status}`);
}

// ---- One computer serves a display per observing screen -------------------
// The headline claim, asserted at the container rather than by HTTP status.
{
  const botId = `dsh-screen-multi-${stamp}`;
  const computer = await createComputer(botId);
  created.push({ botId, ...computer });
  const { computerId, capability } = computer;

  check("computer has a container", containerExists(botId), containerName(botId));
  const baseline = displays(botId);
  check("container carries one default display", baseline.length === 1, JSON.stringify(baseline));

  const screens = [`${botId}-m1`, `${botId}-m2`, `${botId}-m3`];
  for (const screenId of screens) {
    const shot = await request(`/v1/computers/${computerId}/observe`, { method: "POST", capability, screenId });
    check(`observe on ${screenId.slice(-2)}`, shot.status === 200, `status=${shot.status}`);
  }
  const expected = baseline.length + screens.length - 1;
  const after = await displaysUntil(botId, expected);
  check(
    "each screen becomes its own display",
    after.length === expected,
    `baseline=${JSON.stringify(baseline)} after=${JSON.stringify(after)} expected=${expected}`,
  );

  // Revisiting a screen reuses its display instead of allocating another.
  const beforeRevisit = (await displaysUntil(botId, expected)).length;
  await request(`/v1/computers/${computerId}/observe`, { method: "POST", capability, screenId: screens[0] });
  await delay(1_500);
  check(
    "revisiting a screen allocates nothing",
    displays(botId).length === beforeRevisit,
    `before=${beforeRevisit} after=${JSON.stringify(displays(botId))}`,
  );

  // A caller that names no screen uses its own default screen, which is a
  // different key from any named one. So after named screens exist, one plain
  // observe allocates its own display — and repeating it must not allocate more.
  // (The running probe that measured a single named screen first saw no growth,
  // because that first screen had already adopted the container's default.)
  const beforeDefault = (await displaysUntil(botId, expected)).length;
  const plain = await request(`/v1/computers/${computerId}/observe`, { method: "POST", capability });
  check("observe without a screen name still works", plain.status === 200, `status=${plain.status}`);
  const settled = await displaysUntil(botId, beforeDefault + 1);
  check(
    "a default screen is distinct from a named one",
    settled.length === beforeDefault + 1,
    `before=${beforeDefault} after=${JSON.stringify(settled)}`,
  );
  await request(`/v1/computers/${computerId}/observe`, { method: "POST", capability });
  await delay(1_500);
  check(
    "repeating a default observe allocates nothing",
    displays(botId).length === settled.length,
    `settled=${settled.length} after=${JSON.stringify(displays(botId))}`,
  );

  // Exec runs on the shared computer while its displays are live.
  const exec = await request(`/v1/computers/${computerId}/exec`, {
    method: "POST",
    capability,
    body: { argv: ["bash", "-lc", "ls /tmp/.X11-unix | wc -l"] },
  });
  check(
    "exec sees the same displays",
    exec.status === 200 && Number(exec.value.stdout) === displays(botId).length,
    `exec=${JSON.stringify(exec.value.stdout)} container=${displays(botId).length}`,
  );
}

// ---- Destroy removes the container, not merely access to it ---------------
// The resource claim is the container, so assert the container: an assertion on
// a failed `docker exec` would pass for any implementation once it is gone.
{
  const botId = `dsh-screen-destroy-${stamp}`;
  const computer = await createComputer(botId);
  created.push({ botId, ...computer });
  const { computerId, capability } = computer;
  check("computer to destroy exists", containerExists(botId), containerName(botId));

  const destroyed = await destroyComputer(computerId, capability);
  check("destroy accepted", destroyed.status === 200 && destroyed.value.ok === true, JSON.stringify(destroyed.value));

  let gone = false;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !gone) {
    gone = !containerExists(botId);
    if (!gone) await delay(500);
  }
  check("container is actually gone after destroy", gone, containerName(botId));

  const again = await destroyComputer(computerId, capability);
  check(
    "destroying again is idempotent",
    again.status === 200 && again.value.already === true,
    `status=${again.status} ${JSON.stringify(again.value)}`,
  );
  created.splice(created.findIndex((entry) => entry.computerId === computerId), 1);
}

// ---- Cleanup -------------------------------------------------------------
// Every computer this run created is destroyed with its own capability; the
// trailing sweep only mops up anything a failed check left behind, and only
// addresses identities carrying this run's stamp.
for (const entry of [...created]) {
  await destroyComputer(entry.computerId, entry.capability).catch(() => undefined);
}
const leftover = (await request("/v1/computers")).value.computers ?? [];
const mine = leftover.filter((entry) => typeof entry.botId === "string" && entry.botId.includes(`-${stamp}`));
for (const entry of mine) {
  await request(`/v1/computers/${entry.computerId}`, { method: "DELETE", adopt: true });
}
const remaining = ((await request("/v1/computers")).value.computers ?? []).filter(
  (entry) => typeof entry.botId === "string" && entry.botId.includes(`-${stamp}`),
);
check("no computers left behind", remaining.length === 0, JSON.stringify(remaining));

console.log(failures === 0 ? "screen checks: all passed" : `screen checks: ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
