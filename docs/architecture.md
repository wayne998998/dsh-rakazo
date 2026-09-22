# Architecture

## The three pieces

```
┌─────────────────────── DeepSeek Harness process ────────────────────────┐
│                                                                          │
│  plugin/index.js                              providers/*.js            │
│  ────────────────                             ──────────────            │
│  • 7 rakazo_* tools                           • FileSystem subclass     │
│  • identity: dsh-<scope>                      • ShellExecutor subclass   │
│  • capability store (memory only)             • scope from sandboxPolicy │
│  • disposal and prune                                                    │
│                                                                          │
└───────────────┬───────────────────────────────────┬──────────────────────┘
                │ BRIDGE_TOKEN                      │ BRIDGE_TOKEN
                ▼                                   ▼
┌─────────────────────────── bridge process ──────────────────────────────┐
│  src/server.mjs        routes + request log                             │
│  src/computers.mjs     ownership, capability hashes, per-computer lock   │
│  src/api-client.mjs    holds EXTERNAL_COMPUTER_TOKEN                     │
│  src/config.mjs        env first, then an owner-only .env               │
│  Stateless: no database, no leases, no state file, no timers.            │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │ Bearer EXTERNAL_COMPUTER_TOKEN
                                ▼
┌────────────────────────────── Rakazo ───────────────────────────────────┐
│  Service-account surface (apps/api/src/external-computers.ts)            │
│  Decides the space, the home, and the container; never leaks the         │
│  sandbox supervisor URL or token to the caller.                          │
└───────────────────────────────┬─────────────────────────────────────────┘
                                ▼
                    Docker container per identity
              (browser, filesystem, terminal, X displays)
```

## Ownership and identity

Everything rests on one rule: **the calling session derives the computer's identity**, and the
computer is addressed by that identity.

```
botId = "dsh-" + scopeKey
```

`scopeKey` resolution (`plugin/index.js`, `scopeKeyOf`):

| Situation | Scope | Result |
| --- | --- | --- |
| Default (no sharing) | the session's own id | one computer per session |
| `share: true`, top-level agent | its own session id | the Team Lead's computer |
| `share: true`, teammate | the Team root, found by walking `parentSession` | the same computer as its Team |

Identity comes from `agent.session.id` — the harness convention the ACP bridge also relies on
(`Agent` itself guarantees only `{ id }`, see `packages/core/agent/src/types.ts`). Lineage comes from
`agent.session.header.parentSession` when present, otherwise from the session store
(`ctx.sessions.get(id)`), which is the contractual source. A tool call that cannot establish any
identity **fails loudly** rather than guessing.

### Why identity is the caller's, not the computer's

Rakazo re-adopts an existing machine for a known `botId` (`resumed: true`). So the same conversation
reaches the same computer after a harness restart without any state file: the identity is derived
again, not remembered. That is what replaced an earlier design that persisted a registry, renewed
leases, and swept expired ones — and whose failure mode was a silently un-renewed computer being
destroyed under a live session.

## Capabilities

Per-computer authorization is a capability, not a name:

1. `POST /v1/computers {botId}` returns `{ computerId, capability }`.
2. The plugin keeps `computerId → capability` **in memory** for the session.
3. Every later call presents `x-rakazo-computer-capability`.
4. The bridge stores only the capability's SHA-256 and compares by hash.

Consequences worth keeping:

- A restart forgets capabilities. Re-adoption mints a fresh one, and the old value stops working.
- Nothing the bridge can authorize is written to disk, so a stolen disk image yields no authority.
- Two callers cannot reach the same computer by sharing its id, because neither holds the other's
  capability.

## Two ways to reach the computer

| | `rakazo_*` tools (plugin) | native tools (providers) |
| --- | --- | --- |
| Entry point | `plugin/index.js` | `providers/fs-rakazo.js`, `providers/shell-rakazo.js` |
| Scope source | the tool call's `exec.agent` | `sandboxPolicy.sessionId` |
| Best for | desktop, browser, screenshots | files and commands, where native tools are sharper |
| Requires | the plugin row | a composition that mounts `sandbox-policy` |

The providers exist because a model works better with the harness's own `bash`, `read`, `write`, and
`edit` than with wrappers. They receive no agent, so the session arrives differently: a provider that
advertises a `sandboxMode` makes the harness attach `sandboxPolicy` (with the session id) to the
calls that mutate. `providers/bridge.js` turns that id into the same `dsh-<scope>` the plugin uses,
so both paths land on one computer.

Measured behaviour after that fix:

```
same session:  native bash sees the file native fs wrote, same computerId
another session: different computerId
a teammate:     resolves to its Team root — no computer minted for the member
no policy:      falls back to the configured default scope, never throws
```

## Screens

Rakazo keys a display by a screen identity, and the adapter fills it from the computer's identity
unless told otherwise:

```
supervisor:   screenKey = screenId || botId || id
adapter:      x-rakazo-screen-id: context.screenId ?? context.botId
```

So one computer serves one display per screen key. The plugin names a teammate's screen
`dsh-<teamRoot>-<memberSession>`, namespaced under the computer's own `botId`; Rakazo refuses any
screen outside that namespace with `403 screenId does not belong to this computer`.

Observed on a real container:

```
baseline (nothing observed):  X1
first named screen:           X1        ← adopts the container's existing socket
second named screen:          X1 X2
third named screen:           X1 X2 X3
a caller naming no screen:    is its own key, distinct from any named one
```

So N named screens cost `baseline + N - 1` displays, and the first observer is effectively free.

## Lifecycle

```
create ──► (re-adopt if the identity is known) ──► capability minted, held in memory
   │
   ├─ exec / file / observe / browser            serialized per computer
   │
   ├─ destroy                                    idempotent; the plugin forgets the id
   │
   └─ agent/disposed
        ├─ default          destroy what this scope owned
        ├─ keep: true       forget it; it waits to be re-adopted
        └─ share: true      only the principal (Lead) destroys the Team's computer
```

Disposal runs through the agent's own scope carrier (`agent/disposed` is dispatched with the agent
as carrier, see `packages/core/agent/src/index.ts`). Dispatching it any other way silently misses an
agent-scoped listener — a trap that made an earlier version of the test suite vacuous.

At load, the plugin also prunes computers whose owning session no longer exists, but only when the
composition exposes a session store. Without one it logs a skip and leaves computers alone: refusing
to guess is deliberate, since the alternative is destroying a live session's computer.

## What the bridge does not do

- It does not decide identity; the caller does.
- It does not persist anything, so it cannot drift from the machines it names.
- It does not manage machine lifecycle beyond create/stop/destroy: Rakazo owns suspension, workspace
  checkpointing, and recovery.
