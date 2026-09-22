/**
 * Rakazo application API client.
 *
 * The bridge holds a service-account token for the API, never the sandbox
 * supervisor URL or token: computer lifecycle, identity checks, and the space
 * that owns a computer are all decided by Rakazo.
 */

/** Lifecycle calls may build or tear down a container; commands carry their own budget. */
const LIFECYCLE_TIMEOUT_MS = 300_000;
const CONTROL_TIMEOUT_MS = 120_000;

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.statusCode = status;
  }
}

export class ApiClient {
  constructor({ url, token }) {
    this.url = url.replace(/\/$/, "");
    this.token = token;
  }

  async #json(path, { method = "GET", body, entry, screenId, timeoutMs = CONTROL_TIMEOUT_MS } = {}) {
    const headers = new Headers({ authorization: `Bearer ${this.token}` });
    if (entry) headers.set("x-rakazo-bot-id", entry.botId);
    // A caller may name its own screen on a shared computer; Rakazo namespaces
    // the value under the caller's botId and rejects anything outside it.
    if (screenId) headers.set("x-rakazo-screen-id", screenId);
    if (body !== undefined) headers.set("content-type", "application/json");
    let response;
    try {
      response = await fetch(`${this.url}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      throw new ApiError(503, `rakazo api unreachable: ${cause?.message ?? cause}`);
    }
    const text = await response.text();
    let value;
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      value = { error: text.slice(0, 500) };
    }
    if (!response.ok) throw new ApiError(response.status, value.error ?? `rakazo api returned ${response.status}`);
    return value;
  }

  /** Idempotent: Rakazo resumes an existing container for the same bot identity. */
  provision({ botId }) {
    return this.#json("/api/v1/external/computers", {
      method: "POST",
      body: { botId },
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
    });
  }

  exec(entry, { argv, cwd, timeoutMs }) {
    return this.#json(`/api/v1/external/computers/${entry.id}/exec`, {
      method: "POST",
      body: { argv, cwd, timeoutMs },
      entry,
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
    });
  }

  readFile(entry, relative) {
    return this.#json(`/api/v1/external/computers/${entry.id}/files?path=${encodeURIComponent(relative)}`, { entry });
  }

  writeFile(entry, { relative, contentBase64, executable }) {
    return this.#json(`/api/v1/external/computers/${entry.id}/files`, {
      method: "POST",
      body: { path: relative, content: contentBase64, executable },
      entry,
    });
  }

  observe(entry, { screenId } = {}) {
    return this.#json(`/api/v1/external/computers/${entry.id}/observe`, { method: "POST", entry, screenId });
  }

  browser(entry, payload, { screenId } = {}) {
    return this.#json(`/api/v1/external/computers/${entry.id}/browser`, {
      method: "POST",
      body: payload,
      entry,
      screenId,
    });
  }

  stop(entry) {
    return this.#json(`/api/v1/external/computers/${entry.id}/stop`, {
      method: "POST",
      entry,
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
    });
  }

  destroy(entry) {
    return this.#json(`/api/v1/external/computers/${entry.id}`, {
      method: "DELETE",
      entry,
      timeoutMs: LIFECYCLE_TIMEOUT_MS,
    });
  }
}
