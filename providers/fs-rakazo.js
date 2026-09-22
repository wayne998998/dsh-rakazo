/**
 * Rakazo filesystem provider: serves `ctx.fs` from a Rakazo computer over the
 * bridge, so the harness's native `read` / `write` / `edit` tools operate inside
 * the computer's workspace instead of the host filesystem.
 *
 * The bridge only exposes whole-file read (base64) / write (UTF-8) plus argv-form
 * `exec`, so `stat` / `lstat` / `listDir` metadata is derived by running `stat` /
 * `find` inside the computer, and `FsInfo.version` is `size:mtime` of the entry.
 * Workspace paths are normalized to the bridge's workspace-relative form before
 * any request; an absolute path elsewhere or a `..` past the root is refused as
 * `FS_SANDBOX_DENIED`.
 */
import { posix } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";
import { FileSystem, FsError, FsTargetKey, FsVersion } from "@deepseek-ai/dsh-fs";
import {
  WORKSPACE_ROOT,
  WorkspaceEscapeError,
  botIdFor,
  bridgeFetch,
  ensureComputer,
  resolveConfig,
  scopeKeyFor,
  workspaceRel,
} from "./bridge.js";

/** Line-ending style detected before LF normalization (see dsh-fs-local/fsio). */
function normalizeLineEndings(content) {
  return content.replaceAll("\r\n", "\n");
}

function detectLineEndings(raw) {
  const sample = raw.slice(0, 4096);
  const crlfCount = sample.split("\r\n").length - 1;
  const lfCount = sample.split("\n").length - 1 - crlfCount;
  return crlfCount > lfCount ? "CRLF" : "LF";
}

function restoreLineEndings(content, lineEndings) {
  return lineEndings === "LF" ? content : normalizeLineEndings(content).split("\n").join("\r\n");
}

function countOccurrences(content, needle) {
  let count = 0;
  let index = 0;
  while (true) {
    const found = content.indexOf(needle, index);
    if (found === -1) return count;
    count += 1;
    index = found + needle.length;
  }
}

/** Literal-replacement semantics from `dsh-fs-local/fsio` (kept byte-identical). */
function applyLiteralEdit(content, oldString, newString, replaceAll, displayPath) {
  const oldNorm = normalizeLineEndings(oldString);
  if (oldNorm.length === 0) {
    throw new FsError("old_string must be a non-empty string", "FS_EDIT_NOT_FOUND");
  }
  const newNorm = normalizeLineEndings(newString);
  const replacements = countOccurrences(content, oldNorm);
  if (replacements === 0) {
    throw new FsError(`old_string was not found in "${displayPath}"`, "FS_EDIT_NOT_FOUND");
  }
  if (!replaceAll && replacements > 1) {
    throw new FsError(
      `old_string matched ${replacements} times in "${displayPath}"; provide a more specific old_string or set replace_all to true`,
      "FS_AMBIGUOUS_EDIT",
    );
  }
  return { content: content.split(oldNorm).join(newNorm), replacements };
}

/** Decode bridge base64 into validated UTF-8 text, or throw the seam's typed error. */
function decodeText(bytes, verb, displayPath) {
  if (bytes.includes(0)) {
    throw new FsError(`cannot ${verb} "${displayPath}": binary file`, "FS_NOT_TEXT");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new FsError(`cannot ${verb} "${displayPath}": invalid UTF-8 text`, "FS_NOT_TEXT", {
      cause: error,
    });
  }
}

function fsType(typeStr) {
  const type = typeStr.trim();
  if (/regular/.test(type)) return "file";
  if (type === "directory") return "directory";
  return "other";
}

/** Rakazo filesystem backend. */
export class RakazoFileSystem extends FileSystem {
  static inject = ["sandboxPolicy"];

  constructor(ctx, config) {
    super(ctx);
    const settings = config ?? {};
    const { url, token } = resolveConfig(settings);
    this.url = url;
    this.token = token;
    // Default scope for agentless calls (no per-call sandboxPolicy sessionId):
    // `rakazo` is shared with the shell provider. A distinct scope isolates a
    // deployment (or a verification run) on its own computer.
    this.defaultScope =
      typeof settings.scope === "string" && settings.scope ? settings.scope : "rakazo";
    this.defaultBotId = botIdFor(this.defaultScope);
  }

  get sandboxMode() {
    return this.ctx.sandboxPolicy.defaultMode;
  }

  /**
   * Bot identity (`dsh-<scope>`) for one call's sandbox policy: the policy's
   * session id walked to its Team root, else the configured default scope
   * (agentless fallback).
   */
  resolveBotId(sandboxPolicy) {
    const sessionId = sandboxPolicy?.sessionId;
    return sessionId ? botIdFor(scopeKeyFor(sessionId, this.ctx.sessions)) : this.defaultBotId;
  }

  /** Workspace-relative path -> execution-world absolute path. */
  displayPath(rel) {
    return rel === "" ? WORKSPACE_ROOT : `${WORKSPACE_ROOT}/${rel}`;
  }

  cwdBase(cwd) {
    if (!cwd) return "";
    try {
      return workspaceRel(cwd);
    } catch {
      // A host path outside the workspace is meaningless in the Rakazo world;
      // relative resolution falls back to the workspace root.
      return "";
    }
  }

  throwIfAborted(signal, verb) {
    if (signal?.aborted) throw new FsError(`${verb} aborted`, "FS_ABORTED");
  }

  /** Map a bridge/network failure to the seam's `FsError` taxonomy. */
  mapError(error) {
    if (error instanceof FsError) return error;
    const status = error?.status ?? 0;
    const message = error instanceof Error ? error.message : String(error);
    if (error?.aborted === true || (status === 0 && /aborted/.test(message))) {
      return new FsError(message, "FS_ABORTED", { cause: error });
    }
    if (status === 401) return new FsError(message, "FS_IO_ERROR", { cause: error });
    if (status === 403) return new FsError(message, "FS_PERMISSION_DENIED", { cause: error });
    if (status === 404) return new FsError(message, "FS_NOT_FOUND", { cause: error });
    if (status === 413) return new FsError(message, "FS_TOO_LARGE", { cause: error });
    if (status === 400) {
      if (/escape|absolute|traversal|\.\./.test(message)) {
        return new FsError(message, "FS_SANDBOX_DENIED", { cause: error });
      }
      if (/exceed|too large|16 MiB/i.test(message)) {
        return new FsError(message, "FS_TOO_LARGE", { cause: error });
      }
      return new FsError(message, "FS_IO_ERROR", { cause: error });
    }
    return new FsError(message, "FS_IO_ERROR", { cause: error });
  }

  async bridge(path, opts) {
    try {
      return await bridgeFetch(this.url, this.token, path, opts);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async ensure(botId = this.defaultBotId) {
    try {
      return await ensureComputer({ url: this.url, token: this.token, botId });
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async exec(argv, { signal, cwd, timeoutMs } = {}, botId) {
    const { computerId, capability } = await this.ensure(botId);
    const body = { argv };
    if (cwd !== undefined) body.cwd = cwd;
    if (timeoutMs !== undefined) body.timeoutMs = timeoutMs;
    return this.bridge(`/v1/computers/${encodeURIComponent(computerId)}/exec`, {
      method: "POST",
      body,
      capability,
      signal,
    });
  }

  async readFile(rel, { signal } = {}, botId) {
    const { computerId, capability } = await this.ensure(botId);
    return this.bridge(
      `/v1/computers/${encodeURIComponent(computerId)}/files/read?path=${encodeURIComponent(rel)}`,
      { capability, signal },
    );
  }

  async writeFile(rel, content, { signal, executable } = {}, botId) {
    const { computerId, capability } = await this.ensure(botId);
    const body = { path: rel, content };
    if (executable !== undefined) body.executable = executable;
    return this.bridge(`/v1/computers/${encodeURIComponent(computerId)}/files/write`, {
      method: "POST",
      body,
      capability,
      signal,
    });
  }

  /** Probe one entry via `stat` (following symlinks unless `follow: false`). */
  async probe(rel, { follow = true, signal } = {}, botId) {
    const result = await this.exec(["stat", "-c", "%s %Y %F", "--", rel], { signal }, botId);
    if (result.code !== 0) {
      if (/no such file|cannot stat|not found/i.test(result.stderr ?? "")) return undefined;
      throw new FsError(
        `cannot stat "${this.displayPath(rel)}": ${(result.stderr ?? "").trim() || `exit ${result.code}`}`,
        "FS_IO_ERROR",
      );
    }
    const parts = (result.stdout ?? "").trim().split(/\s+/);
    const size = Number(parts[0]);
    const mtime = parts[1];
    let type = fsType(parts.slice(2).join(" "));
    if (!follow) {
      const link = await this.exec(["readlink", "--", rel], { signal }, botId);
      if (link.code === 0) type = "symlink";
    }
    return { version: FsVersion(`${size}:${mtime}`), type, size };
  }

  async resolve(path, opts) {
    this.throwIfAborted(opts?.signal, "resolve");
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
    }
    let rel;
    try {
      rel = workspaceRel(path, this.cwdBase(opts?.cwd));
    } catch (error) {
      if (error instanceof WorkspaceEscapeError) {
        throw new FsError(error.message, "FS_SANDBOX_DENIED", { cause: error });
      }
      throw error;
    }
    return { targetKey: FsTargetKey(rel), displayPath: this.displayPath(rel) };
  }

  processPath(target) {
    return this.displayPath(String(target.targetKey));
  }

  fileUrl(target) {
    return pathToFileURL(this.processPath(target)).href;
  }

  contains(parent, child) {
    const path = posix.relative(String(parent.targetKey), String(child.targetKey));
    return path === "" || (!path.startsWith("../") && path !== ".." && !posix.isAbsolute(path));
  }

  async stat(target, signal) {
    this.throwIfAborted(signal, "stat");
    const info = await this.probe(String(target.targetKey), { signal });
    return info === undefined ? undefined : { version: info.version, type: info.type, size: info.size };
  }

  async lstat(path, opts, signal) {
    this.throwIfAborted(signal, "lstat");
    if (typeof path !== "string" || path.trim().length === 0) {
      throw new FsError("file_path must be a non-empty string", "FS_NOT_FOUND");
    }
    let rel;
    try {
      rel = workspaceRel(path, this.cwdBase(opts?.cwd));
    } catch (error) {
      if (error instanceof WorkspaceEscapeError) {
        throw new FsError(error.message, "FS_SANDBOX_DENIED", { cause: error });
      }
      throw error;
    }
    const info = await this.probe(rel, { follow: false, signal });
    return info === undefined ? undefined : { version: info.version, type: info.type, size: info.size };
  }

  async readText(target, signal) {
    this.throwIfAborted(signal, "read");
    const rel = String(target.targetKey);
    const value = await this.readFile(rel, { signal });
    return decodeText(Buffer.from(value.content ?? "", "base64"), "read", this.displayPath(rel));
  }

  async streamText(target, signal) {
    const text = await this.readText(target, signal);
    return (async function* () {
      yield text;
    })();
  }

  async readBytes(target, signal, maxBytes) {
    this.throwIfAborted(signal, "read");
    const rel = String(target.targetKey);
    const value = await this.readFile(rel, { signal });
    const bytes = Buffer.from(value.content ?? "", "base64");
    if (bytes.length > maxBytes) {
      throw new FsError(
        `cannot read "${this.displayPath(rel)}": ${bytes.length} bytes exceeds the ${maxBytes}-byte limit`,
        "FS_TOO_LARGE",
      );
    }
    return bytes;
  }

  async readByteRange(target, range, signal) {
    this.throwIfAborted(signal, "read");
    if (range.length === 0) return new Uint8Array(0);
    const rel = String(target.targetKey);
    const value = await this.readFile(rel, { signal });
    const bytes = Buffer.from(value.content ?? "", "base64");
    return bytes.subarray(range.offset, range.offset + range.length);
  }

  async listDir(target, signal) {
    this.throwIfAborted(signal, "list");
    const rel = String(target.targetKey);
    const dir = await this.probe(rel, { signal });
    if (dir === undefined) {
      throw new FsError(`cannot list "${this.displayPath(rel)}": not found`, "FS_NOT_FOUND");
    }
    if (dir.type !== "directory") {
      throw new FsError(`cannot list "${this.displayPath(rel)}": not a directory`, "FS_NOT_DIRECTORY");
    }
    const findPath = rel === "" ? "." : rel;
    const result = await this.exec(
      ["find", findPath, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\t%s\t%T@\t%y\n"],
      { signal },
    );
    if (result.code !== 0) {
      throw new FsError(
        `cannot list "${this.displayPath(rel)}": ${(result.stderr ?? "").trim() || `exit ${result.code}`}`,
        "FS_IO_ERROR",
      );
    }
    const entries = [];
    for (const line of (result.stdout ?? "").split("\n")) {
      if (!line) continue;
      const [name, sizeStr, mtime, typeChar] = line.split("\t");
      const childRel = rel === "" ? name : `${rel}/${name}`;
      const type = typeChar === "d" ? "directory" : typeChar === "f" ? "file" : "other";
      entries.push({
        name,
        type,
        target: { targetKey: FsTargetKey(childRel), displayPath: this.displayPath(childRel) },
        version: FsVersion(`${sizeStr}:${mtime}`),
        ...(type === "file" ? { size: Number(sizeStr) } : {}),
      });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return entries;
  }

  async writeText(target, content, expected, signal, sandboxPolicy) {
    const rel = String(target.targetKey);
    const botId = this.resolveBotId(sandboxPolicy);
    this.throwIfAborted(signal, "write");
    const existing = await this.probe(rel, { signal }, botId);
    if (existing !== undefined && existing.type !== "file") {
      throw new FsError(`cannot write "${this.displayPath(rel)}": not a regular file`, "FS_NOT_REGULAR_FILE");
    }
    if (expected?.kind === "replaceIfVersion") {
      if (existing === undefined) {
        throw new FsError(`cannot write "${this.displayPath(rel)}": file no longer exists`, "FS_STALE_VERSION");
      }
      if (existing.version !== expected.version) {
        throw new FsError(`cannot write "${this.displayPath(rel)}": file changed since it was read`, "FS_STALE_VERSION");
      }
    } else if (expected?.kind === "createIfAbsent" && existing !== undefined) {
      throw new FsError(
        `cannot overwrite existing "${this.displayPath(rel)}" without reading it first`,
        "FS_NOT_OBSERVED",
      );
    }

    const before = existing === undefined ? null : await this.readForDiff(rel, signal, botId);
    await this.writeFile(rel, content, { signal }, botId);
    const after = await this.probe(rel, { signal }, botId);
    return {
      operation: existing === undefined ? "create" : "update",
      version: after ? after.version : FsVersion(`missing:${rel}`),
      before,
      after: normalizeLineEndings(content),
    };
  }

  async editText(target, edit, expected, signal, sandboxPolicy) {
    const rel = String(target.targetKey);
    const botId = this.resolveBotId(sandboxPolicy);
    this.throwIfAborted(signal, "edit");
    const existing = await this.probe(rel, { signal }, botId);
    if (existing === undefined) {
      throw new FsError(`cannot edit "${this.displayPath(rel)}": file changed since it was read`, "FS_STALE_VERSION");
    }
    if (existing.type !== "file") {
      throw new FsError(`cannot edit "${this.displayPath(rel)}": not a regular file`, "FS_NOT_REGULAR_FILE");
    }
    if (expected && existing.version !== expected.version) {
      throw new FsError(`cannot edit "${this.displayPath(rel)}": file changed since it was read`, "FS_STALE_VERSION");
    }

    const original = await this.readForEdit(rel, signal, botId);
    const edited = applyLiteralEdit(
      original.content,
      edit.oldString,
      edit.newString,
      edit.replaceAll,
      this.displayPath(rel),
    );
    const content = restoreLineEndings(edited.content, original.lineEndings);
    await this.writeFile(rel, content, { signal }, botId);
    const after = await this.probe(rel, { signal }, botId);
    return {
      version: after ? after.version : FsVersion(`missing:${rel}`),
      before: original.content,
      after: edited.content,
    };
  }

  /** Best-effort diff basis (LF-normalized text, else null), never fatal. */
  async readForDiff(rel, signal, botId) {
    try {
      const value = await this.readFile(rel, { signal }, botId);
      const bytes = Buffer.from(value.content ?? "", "base64");
      if (bytes.includes(0)) return null;
      try {
        return normalizeLineEndings(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch {
        return null;
      }
    } catch {
      return null;
    }
  }

  async readForEdit(rel, signal, botId) {
    this.throwIfAborted(signal, "edit");
    const value = await this.readFile(rel, { signal }, botId);
    const bytes = Buffer.from(value.content ?? "", "base64");
    if (bytes.includes(0)) {
      throw new FsError(`cannot edit "${this.displayPath(rel)}": binary file`, "FS_NOT_TEXT");
    }
    const raw = decodeText(bytes, "edit", this.displayPath(rel));
    return { content: normalizeLineEndings(raw), lineEndings: detectLineEndings(raw) };
  }
}

export default RakazoFileSystem;
