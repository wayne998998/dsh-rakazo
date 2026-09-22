/**
 * HTTP control plane for the Rakazo bridge.
 *
 * Two credentials are required and they are not interchangeable: the service
 * bearer token authenticates the caller (the harness plugin), and a per-computer
 * capability authorizes the specific computer being addressed. Rakazo's
 * service-account token stays inside this process.
 *
 * The bridge keeps no state of its own: identity is the caller's session-derived
 * `botId`, and capabilities live only in memory, so a restart forgets them and
 * re-derives nothing from disk.
 */
import http from "node:http";
import { ApiClient } from "./api-client.mjs";
import { ComputerControl } from "./computers.mjs";
import { loadBridgeConfig } from "./config.mjs";

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const capabilityHeader = "x-rakazo-computer-capability";

const config = loadBridgeConfig();
const api = new ApiClient({ url: config.apiUrl, token: config.apiToken });
const control = new ComputerControl({ api });

function json(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function fail(res, error) {
  const status = error?.statusCode ?? 500;
  json(res, status, { error: error instanceof Error ? error.message : String(error) });
}

function authorized(req) {
  return req.headers.authorization === `Bearer ${config.bridgeToken}`;
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw Object.assign(new Error("request body too large"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("invalid JSON"), { statusCode: 400 });
  }
}

async function route(req, res, url) {
  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true, api: config.apiUrl, computers: control.list().length });
  }
  if (url.pathname === "/v1/computers") {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    if (req.method === "GET") return json(res, 200, { computers: control.list() });
    if (req.method === "POST") return json(res, 200, await control.create(await readBody(req)));
  }
  const match = url.pathname.match(/^\/v1\/computers\/([^/]+)(?:\/(.*))?$/);
  if (match) {
    if (!authorized(req)) return json(res, 401, { error: "unauthorized" });
    const computerId = match[1];
    const capability = req.headers[capabilityHeader];
    const screenId = req.headers["x-rakazo-screen-id"];
    const suffix = match[2] ?? "";
    const body = req.method === "GET" || req.method === "DELETE" ? {} : await readBody(req);
    switch (`${req.method} ${suffix}`) {
      case "GET ":
        return json(res, 200, await control.status(computerId, capability));
      case "POST exec":
        return json(res, 200, await control.exec(computerId, capability, body));
      case "GET files/read":
        return json(res, 200, await control.readFile(computerId, capability, url.searchParams.get("path") ?? ""));
      case "POST files/write":
        return json(res, 200, await control.writeFile(computerId, capability, body));
      case "POST observe":
        return json(res, 200, await control.observe(computerId, capability, { screenId }));
      case "POST browser":
        return json(res, 200, await control.browser(computerId, capability, body, { screenId }));
      case "POST stop":
        return json(res, 200, await control.stop(computerId, capability));
      case "DELETE ":
        return json(res, 200, await control.destroy(computerId, capability, { adopt: req.headers["x-rakazo-adopt"] === "1" }));
      default:
        return json(res, 404, { error: "not found" });
    }
  }
  return json(res, 404, { error: "not found" });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${config.host}:${config.port}`);
  const started = Date.now();
  res.on("finish", () => {
    console.log(`dsh-rakazo-bridge req ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
  });
  route(req, res, url).catch((error) => fail(res, error));
});

server.listen(config.port, config.host, () => {
  console.log(`dsh-rakazo-bridge listening on http://${config.host}:${config.port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => server.close(() => process.exit(0)));
}
