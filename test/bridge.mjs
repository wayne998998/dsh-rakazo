/**
 * End-to-end checks for the bridge control plane.
 *
 * Runs against a live bridge and a live Rakazo supervisor: every computer it
 * creates is destroyed before it finishes. Asserts the ownership model, not
 * implementation detail: capabilities gate access, computers are isolated from
 * each other, identity re-adopts the same computer, operations are idempotent,
 * and nothing the bridge can authorize is written to disk.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadBridgeClientConfig } from "../src/config.mjs";

const { url, token } = loadBridgeClientConfig();
const service = { authorization: `Bearer ${token}` };
/** The state directory the previous design kept; it must not come back. */
const legacyStateFile = fileURLToPath(new URL("../state/computers.json", import.meta.url));

let failures = 0;
function check(name, condition, detail) {
  if (condition) {
    console.log(`${name}=ok`);
    return;
  }
  failures += 1;
  console.log(`${name}=FAIL ${detail ?? ""}`);
}

async function request(path, { method = "GET", body, capability, headers = {}, anonymous = false } = {}) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(anonymous ? {} : service),
      ...(capability ? { "x-rakazo-computer-capability": capability } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
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

const health = await request("/health");
check("health", health.status === 200 && health.value.ok === true, JSON.stringify(health.value));

const anonymous = await request("/v1/computers", { anonymous: true });
check("service token required", anonymous.status === 401, `status=${anonymous.status}`);

const missing = await request("/v1/nope", { anonymous: true });
check("unknown route", missing.status === 404, `status=${missing.status}`);

const invalidBotId = await request("/v1/computers", { method: "POST", body: { botId: "../escape" } });
check("invalid botId rejected", invalidBotId.status === 400, `status=${invalidBotId.status}`);

const identityA = `dsh-check-a-${Date.now()}`;
const identityB = `dsh-check-b-${Date.now()}`;

const first = await request("/v1/computers", { method: "POST", body: { botId: identityA } });
check("create", first.status === 200 && typeof first.value.computerId === "string", JSON.stringify(first.value));
check("create returns capability", typeof first.value.capability === "string" && first.value.capability.length === 64);
check("create echoes the caller identity", first.value.botId === identityA, `botId=${first.value.botId}`);
check("first create is not a resume", first.value.resumed === false, `resumed=${first.value.resumed}`);

const { computerId: a, capability: capabilityA } = first.value;
const again = await request("/v1/computers", { method: "POST", body: { botId: identityA } });
check(
  "same identity re-adopts the same computer",
  again.status === 200 && again.value.computerId === a && again.value.resumed === true,
  JSON.stringify(again.value),
);
const capabilityA2 = again.value.capability;
check("re-adoption rotates the capability", capabilityA2 !== capabilityA);

const second = await request("/v1/computers", { method: "POST", body: { botId: identityB } });
const { computerId: b, capability: capabilityB } = second.value;
check("a different identity gets a different computer", a !== b && capabilityA2 !== capabilityB);

try {
  const noCapability = await request(`/v1/computers/${a}`);
  check("capability required", noCapability.status === 403, `status=${noCapability.status}`);

  const wrongCapability = await request(`/v1/computers/${a}`, { capability: capabilityB });
  check("foreign capability rejected", wrongCapability.status === 403, `status=${wrongCapability.status}`);

  const crossExec = await request(`/v1/computers/${b}/exec`, {
    method: "POST",
    capability: capabilityA2,
    body: { argv: ["/bin/true"] },
  });
  check("cross-computer access rejected", crossExec.status === 403, `status=${crossExec.status}`);

  const status = await request(`/v1/computers/${a}`, { capability: capabilityA2 });
  check("status", status.status === 200 && status.value.running === true, JSON.stringify(status.value));

  const pwd = await request(`/v1/computers/${a}/exec`, {
    method: "POST",
    capability: capabilityA2,
    body: { argv: ["pwd"] },
  });
  check(
    "exec runs inside the computer",
    pwd.status === 200 && pwd.value.stdout === "/home/rakazo\n" && pwd.value.code === 0,
    JSON.stringify(pwd.value),
  );

  const traversal = await request(`/v1/computers/${a}/files/read?path=${encodeURIComponent("../../.env")}`, {
    capability: capabilityA2,
  });
  check("path traversal rejected", traversal.status === 400, `status=${traversal.status}`);

  const invalidArgv = await request(`/v1/computers/${a}/exec`, {
    method: "POST",
    capability: capabilityA2,
    body: { argv: [] },
  });
  check("empty argv rejected", invalidArgv.status === 400, `status=${invalidArgv.status}`);

  const oversizedTimeout = await request(`/v1/computers/${a}/exec`, {
    method: "POST",
    capability: capabilityA2,
    body: { argv: ["/bin/true"], timeoutMs: 999_999 },
  });
  check("unbounded timeout rejected", oversizedTimeout.status === 400, `status=${oversizedTimeout.status}`);

  const write = await request(`/v1/computers/${a}/files/write`, {
    method: "POST",
    capability: capabilityA2,
    body: { path: "validation/result.txt", content: "bridge-ok" },
  });
  check("file write", write.status === 200 && write.value.ok === true, JSON.stringify(write.value));

  const read = await request(`/v1/computers/${a}/files/read?path=validation%2Fresult.txt`, { capability: capabilityA2 });
  const decoded = Buffer.from(read.value.content ?? "", "base64").toString("utf8");
  check("file read", read.status === 200 && decoded === "bridge-ok", `decoded=${JSON.stringify(decoded)}`);

  const observation = await request(`/v1/computers/${a}/observe`, { method: "POST", capability: capabilityA2 });
  check(
    "observe returns an image",
    observation.status === 200 && observation.value.mimeType === "image/png" && observation.value.image.length > 1000,
    JSON.stringify({ mimeType: observation.value.mimeType, bytes: observation.value.image?.length }),
  );

  const unknown = await request("/v1/computers/deadbeef", { capability: capabilityA2 });
  check("unknown computer rejected", unknown.status === 404, `status=${unknown.status}`);

  // Nothing the bridge can authorize may exist outside this process. The old
  // design's state file held hashed capabilities; its absence is the check.
  check("bridge keeps no state on disk", !existsSync(legacyStateFile));

  const stopFirst = await request(`/v1/computers/${a}/stop`, { method: "POST", capability: capabilityA2 });
  const stopAgain = await request(`/v1/computers/${a}/stop`, { method: "POST", capability: capabilityA2 });
  check(
    "stop is idempotent",
    stopFirst.status === 200 && stopFirst.value.already === false && stopAgain.value.already === true,
    JSON.stringify({ first: stopFirst.value, again: stopAgain.value }),
  );

  const destroyed = await request(`/v1/computers/${a}`, { method: "DELETE", capability: capabilityA2 });
  check("destroy", destroyed.status === 200 && destroyed.value.ok === true, JSON.stringify(destroyed.value));
  const destroyedAgain = await request(`/v1/computers/${a}`, { method: "DELETE", capability: capabilityA2 });
  check(
    "destroy is idempotent",
    destroyedAgain.status === 200 && destroyedAgain.value.already === true,
    `status=${destroyedAgain.status} ${JSON.stringify(destroyedAgain.value)}`,
  );
} finally {
  for (const [computerId, capability] of [
    [a, capabilityA2],
    [b, capabilityB],
  ]) {
    await request(`/v1/computers/${computerId}`, { method: "DELETE", capability }).catch(() => undefined);
  }
}

console.log(failures === 0 ? "bridge checks: all passed" : `bridge checks: ${failures} failed`);
process.exitCode = failures === 0 ? 0 : 1;
