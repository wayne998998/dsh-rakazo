# dsh-rakazo-computer-use

A [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) bundle that registers the
`rakazo` computer-use provider and seven tools. Each Agent session gets one disposable Rakazo Linux
desktop and is destroyed when that session is disposed.

## What it contributes

| Row | Package |
| --- | --- |
| `computer-use` | `@deepseek-ai/dsh-computer-use` (the exclusive provider seam) |
| `rakazo-computer-use` | `dsh-rakazo-computer-use` (this package) |

Tools: `rakazo_computer_create`, `rakazo_computer_exec`, `rakazo_computer_observe`,
`rakazo_computer_browser`, `rakazo_computer_destroy`, `rakazo_computers` (list, or status with an id),
`rakazo_file` (`op: read | write`).

## Prerequisites

This bundle is the Harness half of a deployment. It does nothing useful on its own.

1. **A Rakazo deployment** exposing the service-authenticated external-computer routes
   (`POST /api/v1/external/computers`, `…/:id/exec`, `…/:id/files`, `…/:id/observe`, `…/:id/browser`,
   `…/:id/stop`, `DELETE …/:id`) behind `EXTERNAL_COMPUTER_TOKEN` and a pinned space id.
2. **A running bridge** that holds the Rakazo service token. Prefer loopback:
   `BRIDGE_URL=http://127.0.0.1:7400`.
3. **`BRIDGE_TOKEN`** in the Harness process environment, equal to the bridge's own token. The model
   never sees it, and the bridge is not reachable from a tool call.

## Install

```sh
# tarball (no build, no registry)
dsh plugin --profile web add ./dsh-rakazo-computer-use-0.1.0.tgz

# npm
dsh plugin --profile web add dsh-rakazo-computer-use

# git — no build step, so no prepare script and no pnpm build allowance. Pin a commit.
dsh plugin --profile web add github:<owner>/dsh-rakazo-computer-use#<sha>
```

Then export `BRIDGE_TOKEN` where the Harness process reads it and boot.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | `http://127.0.0.1:7400` | Bridge base URL. |
| `token` | `$BRIDGE_TOKEN` | Bridge credential; prefer the environment over committing it here. |
| `envFile` | — | Development shortcut: read `BRIDGE_URL`/`BRIDGE_TOKEN` from a `.env` at this path when the environment lacks them. |
| `keep` | `false` | When `true`, disposal forgets a computer instead of destroying it, so a later session with the same identity re-adopts it. |
| `share` | `false` | When `true`, every teammate of one Agent Team uses that Team's computer, the way a shared team computer works. Only the Lead's disposal ends it; a teammate leaving the roster does not. |

## Sharing a computer with an Agent Team

`share: true` maps every teammate of one Team onto the Team's root session, so all of them act on
one computer: they read each other's files and share browser sessions. This is a deliberate trade
and it is **not** an isolation boundary — pair it with `@deepseek-ai/dsh-experimental-agent-team`,
and leave `share` unset when conversations must stay isolated from one another.

## How ownership works

There is no lease, no heartbeat, and no state file. Identity is derived from the session
(`botId = dsh-<sessionId>`), so:

- The model never chooses a computer's identity.
- Rakazo re-adopts the same machine for a known `botId`; a fresh Harness process reaches the same
  computer through the same session, with the workspace intact.
- A computer is reachable only through the capability this process holds for it, so naming another
  session's computer fails.
- Capabilities live in memory only: a restart invalidates them and re-issues new ones, and nothing
  the bridge can authorize is ever written to disk.
- Disposal destroys the session's computers unless `keep` is set; a computer left behind by a crash
  is reclaimed on the next load for sessions that no longer exist, in compositions that expose a
  session store.

## Boundaries

- One computer-use provider per deployment: this layer inserts the seam, so a deployment already
  running another provider must drop one row rather than mount both.
- `exec` timeouts and cancellations may already have taken effect: inspect before repeating.
- With `keep: true` nothing destroys an abandoned computer automatically. The computer waits for its
  session identity, and a session store that no longer lists it makes it prunable; otherwise rely on
  the provider's own idle policy. Leave `keep` unset unless you need continuation, because the
  default (destroy on disposal) is what guarantees a closed conversation leaves no container.
- `prune` needs a composition that exposes a session store; without one it logs a skip and leaves
  computers alone rather than guessing that one is abandoned.
