/**
 * Bridge configuration.
 *
 * Secrets are read from the environment first and otherwise from an owner-only
 * `.env` beside this project. The bridge holds a service-account token for the
 * Rakazo API only: it never receives the sandbox supervisor URL or token.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The deployment's env file. Resolved from this module's location rather than
 * the working directory, so the bridge runs from anywhere without a fixed path.
 * `BRIDGE_ENV_FILE` overrides it for deployments that keep secrets elsewhere.
 */
export const BRIDGE_ENV_FILE =
  process.env.BRIDGE_ENV_FILE ?? resolve(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"));

export function envValue(key, file) {
  try {
    const line = readFileSync(file, "utf8")
      .split(/\r?\n/)
      .find((value) => value.startsWith(`${key}=`));
    return line?.slice(key.length + 1) || undefined;
  } catch {
    return undefined;
  }
}

function required(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

/** Settings for the bridge server itself. */
export function loadBridgeConfig(env = process.env) {
  return {
    host: env.BRIDGE_HOST ?? "127.0.0.1",
    port: Number(env.BRIDGE_PORT ?? 7400),
    bridgeToken: required("BRIDGE_TOKEN", env.BRIDGE_TOKEN ?? envValue("BRIDGE_TOKEN", BRIDGE_ENV_FILE)),
    apiUrl: env.RAKAZO_API_URL ?? envValue("RAKAZO_API_URL", BRIDGE_ENV_FILE) ?? "http://127.0.0.1:3100",
    apiToken: required(
      "RAKAZO_EXTERNAL_TOKEN",
      env.RAKAZO_EXTERNAL_TOKEN ?? envValue("RAKAZO_EXTERNAL_TOKEN", BRIDGE_ENV_FILE),
    ),
  };
}

/** Settings for a client of the bridge: the harness plugin, or a check script. */
export function loadBridgeClientConfig(env = process.env) {
  return {
    url: (env.BRIDGE_URL ?? envValue("BRIDGE_URL", BRIDGE_ENV_FILE) ?? "http://127.0.0.1:7400").replace(/\/$/, ""),
    token: required("BRIDGE_TOKEN", env.BRIDGE_TOKEN ?? envValue("BRIDGE_TOKEN", BRIDGE_ENV_FILE)),
  };
}
