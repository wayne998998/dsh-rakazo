/**
 * Rakazo shell executor for the bash capability seam.
 *
 * Runs the harness's native `bash` tool inside a Rakazo computer over the
 * bridge (route B), instead of the host machine. Implements `resolve`, `run`,
 * and `start` of `@deepseek-ai/dsh-shell`'s `ShellExecutor`.
 *
 * The bridge `exec` route is foreground-only and argv-form: it returns one
 * `{ stdout, stderr, code }` and exposes no streaming, no stdin pipe, and no
 * background process handle. Consequently:
 * - `run` maps one resolved spec onto one bridge exec (argv `["bash","-lc",cmd]`),
 *   classifies the bridge's 124/"timed out" signal as `timedOut`, and maps a
 *   caller abort to `aborted` (aborting the local fetch; the bridge has no kill
 *   route, so a long-running remote command still runs to its own timeout).
 * - `start` throws a loud, descriptive error rather than fabricating a live
 *   `ShellProcess` the bridge cannot back.
 * - `sandboxMode` advertises the deployment's default mode (mirrors fs-ssh), so
 *   the harness attaches the per-call sandbox policy and the executor can route
 *   to the calling session's computer.
 *
 * The bridge endpoint and credential are read from the row `config`
 * (`{ url, token, envFile }`) with the same environment fallback as
 * `plugin/index.js` (see `./bridge.js` `resolveConfig`). An optional
 * `config.scope` sets the default scope for agentless calls (default `rakazo`
 * → `dsh-rakazo`), letting a verification run isolate its own computer; a call
 * carrying a `sandboxPolicy.sessionId` routes to `dsh-<session root>` instead.
 */
import { ShellExecutor } from '@deepseek-ai/dsh-shell'
import { botIdFor, bridgeFetch, ensureComputer, resolveConfig, scopeKeyFor } from './bridge.js'

/** Bridge `exec` timeout bounds (inclusive, milliseconds). */
const BRIDGE_MIN_TIMEOUT_MS = 1_000
const BRIDGE_MAX_TIMEOUT_MS = 300_000
/** Default foreground timeout when the request omits `timeoutMs`. */
const DEFAULT_TIMEOUT_MS = 120_000
/** Foreground stdout capture budget the spec must carry (not enforced by the bridge). */
const DEFAULT_STDOUT_MAX_BYTES = 64_000
/** Default scope suffix; the shared `dsh-rakazo` identity (matches fs-rakazo). */
const DEFAULT_SCOPE = 'rakazo'
/** Exit code the bridge (via GNU `timeout`) reports for a timed-out command. */
const TIMEOUT_EXIT_CODE = 124

/** Empty captured stream, for aborts that never observed output. */
function emptyOutput() {
  return { text: '', truncated: false }
}

/**
 * Clamp a caller timeout hint to the bridge's accepted range. Absent uses the
 * executor default; a supplied value must be positive and finite, and is then
 * rounded to an integer and clamped to `[1000, 300000]`.
 */
function resolveTimeout(requested) {
  if (requested !== undefined && (!Number.isFinite(requested) || requested <= 0)) {
    throw new Error(`shell-rakazo: request.timeoutMs must be a positive finite number`)
  }
  const raw = requested ?? DEFAULT_TIMEOUT_MS
  return Math.min(Math.max(Math.round(raw), BRIDGE_MIN_TIMEOUT_MS), BRIDGE_MAX_TIMEOUT_MS)
}

/** A bridge exec error is a timeout when it carries the timeout code or message. */
function isTimeout(response) {
  return response.code === TIMEOUT_EXIT_CODE || /timed out/i.test(response.stderr ?? '')
}

export default class RakazoShellExecutor extends ShellExecutor {
  static inject = ['sandboxPolicy']

  constructor(ctx, config) {
    super(ctx)
    // A plain property (not a `#private` field): cordis serves services through
    // a Proxy, and private fields are unreachable through it.
    this.bridge = resolveConfig(config)
    // Default scope for agentless calls (no per-call sandboxPolicy sessionId).
    this.defaultScope =
      typeof config?.scope === 'string' && config.scope ? config.scope : DEFAULT_SCOPE
  }

  /**
   * Advertise the deployment's default mode so the harness attaches the
   * per-call sandbox policy (mirrors `packages/ssh/fs-ssh/src/index.ts`).
   */
  get sandboxMode() {
    return this.ctx.sandboxPolicy.defaultMode
  }

  /**
   * Bot identity (`dsh-<scope>`) for one call's sandbox policy: the policy's
   * session id walked to its Team root, else the configured default scope
   * (agentless fallback).
   */
  resolveBotId(sandboxPolicy) {
    const sessionId = sandboxPolicy?.sessionId
    return sessionId
      ? botIdFor(scopeKeyFor(sessionId, this.ctx.sessions))
      : botIdFor(this.defaultScope)
  }

  /**
   * Fill defaults and caps for a request. `workdir` defaults to the computer's
   * workspace root (the bridge treats an empty `cwd` as the computer home);
   * `timeoutMs` is clamped to the bridge's `[1000, 300000]` range.
   */
  resolve(request) {
    return {
      command: request.command,
      workdir: request.workdir ?? '',
      timeoutMs: resolveTimeout(request.timeoutMs),
      stdoutMaxBytes: request.stdoutMaxBytes ?? DEFAULT_STDOUT_MAX_BYTES,
      ...request.signal !== undefined ? { signal: request.signal } : {},
      ...request.stdin !== undefined ? { stdin: request.stdin } : {},
      ...request.env !== undefined ? { env: request.env } : {},
      ...request.dshEnv !== undefined ? { dshEnv: request.dshEnv } : {},
      sandboxPolicy: request.sandboxPolicy,
    }
  }

  /**
   * Run one command to completion over the bridge. Rejects only for
   * infrastructure failures (unreachable bridge, bad capability, invalid
   * workdir); nonzero exits, timeouts, and aborts resolve with a
   * `ShellRunResult`.
   */
  async run(spec) {
    const { url, token } = this.bridge
    const { computerId, capability } = await ensureComputer({
      url,
      token,
      botId: this.resolveBotId(spec.sandboxPolicy),
    })

    const controller = new AbortController()
    const onAbort = () => controller.abort()
    if (spec.signal !== undefined) {
      if (spec.signal.aborted) controller.abort()
      else spec.signal.addEventListener('abort', onAbort, { once: true })
    }

    try {
      const response = await bridgeFetch(url, token, `/v1/computers/${computerId}/exec`, {
        method: 'POST',
        body: {
          argv: ['bash', '-lc', spec.command],
          cwd: spec.workdir,
          timeoutMs: spec.timeoutMs,
        },
        capability,
        signal: controller.signal,
      })
      const timedOut = isTimeout(response)
      return {
        exitCode: timedOut ? null : response.code,
        signal: null,
        timedOut,
        aborted: false,
        timeoutMs: spec.timeoutMs,
        stdout: { text: response.stdout ?? '', truncated: false },
        stderr: { text: response.stderr ?? '', truncated: false },
      }
    } catch (error) {
      const aborted = spec.signal?.aborted === true
        || error?.aborted === true
        || error?.name === 'AbortError'
      if (aborted) {
        return {
          exitCode: null,
          signal: null,
          timedOut: false,
          aborted: true,
          timeoutMs: spec.timeoutMs,
          stdout: emptyOutput(),
          stderr: emptyOutput(),
        }
      }
      throw error
    } finally {
      if (spec.signal !== undefined) spec.signal.removeEventListener('abort', onAbort)
    }
  }

  /**
   * The bridge has no background/streaming exec, so a live `ShellProcess`
   * cannot be satisfied honestly. Throw loud rather than return a fake handle.
   */
  async start() {
    throw new Error(
      'shell-rakazo: background processes are not supported — the Rakazo bridge exec route is foreground-only (no streaming, no process handle). Use run() instead.',
    )
  }
}
