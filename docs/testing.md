# Testing

Everything here runs against real systems: a live bridge, a live Rakazo API, and real Docker
containers. Nothing is mocked, because the properties worth protecting — real displays, real
containers, real identity — do not survive mocking.

Every suite destroys the computers it creates, and each asserts that nothing was left behind.

## Running them

```sh
npm run test:bridge     # 27 checks
npm run test:screens    # 19 checks
npm run test:plugin     # 18 checks
npm test                # all three in order
```

| Suite | Needs | Why |
| --- | --- | --- |
| `test/bridge.mjs` | Node, this repo's `.env` | Drives the bridge over HTTP |
| `test/screens.mjs` | Node, this repo's `.env`, `RAKAZO_ENV_FILE` for the Rakazo token, Docker | Asserts displays inside containers |
| `test/plugin.mjs` | The Harness packages | Mounts the real DSH registries |

`test:plugin` needs a DeepSeek Harness checkout, because the harness's packages resolve only under
its own module graph (its `@deepseek-ai/cordis` is a pnpm workspace package, so plain `node` cannot
import it). `scripts/run-plugin-suite.mjs` stages the suite inside that checkout, runs it with the
harness's own toolchain, and removes the staging afterwards:

```sh
DSH_HARNESS=/path/to/deepseek-harness npm run test:plugin
# or: node scripts/run-plugin-suite.mjs --harness /path/to/deepseek-harness
```

There is no default harness path: omitting it exits with usage rather than guessing.

Environment overrides, so the suites are not tied to one machine:

| Variable | Used by | Default |
| --- | --- | --- |
| `BRIDGE_ENV_FILE` | all | `<repo>/.env` |
| `RAKAZO_ENV_FILE` | screens | **required** — path to the Rakazo deployment's `.env` |
| `EXTERNAL_COMPUTER_TOKEN` | screens | alternative to `RAKAZO_ENV_FILE` |
| `DSH_HARNESS` | plugin | **required** — path to a DeepSeek Harness checkout |

## What each suite actually proves

### `test/bridge.mjs` — the control plane

| Check | Property |
| --- | --- |
| service token required / unknown route | The surface is not open by accident |
| invalid botId rejected | Identity syntax is enforced before any work |
| create echoes the caller identity | Identity comes from the caller, not the bridge |
| same identity re-adopts the same computer | Re-adoption works, `resumed: true` |
| re-adoption rotates the capability | An old capability stops working after re-adoption |
| capability required / foreign rejected / cross-computer rejected | Capabilities gate access per computer |
| path traversal, empty argv, unbounded timeout rejected | Inputs are bounded |
| file write + read round trip, observe returns an image | The computer is actually usable |
| stop and destroy are idempotent | Repeated teardown is safe |
| **bridge keeps no state on disk** | No registry, no leases, nothing to drift |

### `test/screens.mjs` — screens on a shared computer

The interesting assertions are at the container, not at HTTP: a `200` proves only that a request was
accepted, while a socket in `/tmp/.X11-unix` is what a screen actually costs.

| Check | Property |
| --- | --- |
| foreign screen name refused (403) | Screens are namespaced under the caller's own computer |
| malformed screen name rejected (400) | The rule validates syntax before ownership |
| own namespaced screen accepted | The legal path works |
| container carries one default display | Establishes the baseline rather than assuming it |
| each screen becomes its own display | N screens ⇒ `baseline + N - 1` sockets |
| revisiting a screen allocates nothing | Idempotent per screen |
| a default screen is distinct from a named one | Naming no screen is its own key |
| repeating a default observe allocates nothing | Idempotent for the default too |
| exec sees the same displays | Command and screen paths agree on one machine |
| container is actually gone after destroy | Asserts the *container*, not a failed `docker exec` |

That last one is deliberate: an assertion on `displays() === []` after destroy passes for any
implementation, because the container is gone and `docker exec` fails. It was rewritten after
proving a fake destroy would otherwise satisfy it.

### `test/plugin.mjs` — plugin contracts

| Check | Property |
| --- | --- |
| tool surface is the merged seven | The public tool set does not drift silently |
| identity is the session-derived name | `dsh-<session>` |
| re-creating re-adopts the same computer | Stability across calls |
| a second session gets its own computer | Sessions are isolated |
| a session cannot address another's computer | Ownership is enforced in the plugin |
| a forgotten id is reported, not silently accepted | Destroying forgets, so a stale id says so |
| teammate resolves to the Team's computer | Scope walks `parentSession` to the Team root |
| teammate observes on its own named screen | `dsh-<teamRoot>-<memberSession>` |
| lead observes on the computer's own screen | No screen name for the principal |
| teammate's disposal leaves the shared computer running | A roster change does not end the workspace |
| another teammate still works after a peer left | The shared computer stays usable |
| lead's disposal ends the shared computer | The principal owns the lifecycle |
| disposal destroys the session's computer | Default disposal is destructive |
| no computers left behind | Cleanup is verified, not assumed |

## Falsifiability

A test that cannot fail is worse than no test, so each behavioural assertion was verified by breaking
the behaviour and confirming the failure:

| Sabotage | Expected failure | Confirmed |
| --- | --- | --- |
| `screenIdFor` always returns `undefined` | `a teammate observes on its own named screen` | yes |
| shared-mode guard reverted to an identity comparison | `a teammate's disposal leaves the shared computer running` | yes |
| `destroy` reports success without deleting | `the container is actually gone after destroy` | yes |
| scope resolution ignores lineage | `teammate resolves to the Team's computer` | yes |

When adding an assertion, run this loop. If you cannot make it fail, it is not testing behaviour.

## Traps found while building these suites

These cost real time and are worth knowing before you extend the tests:

1. **`agent/disposed` must be dispatched with the agent as carrier.**
   The harness emits `dispatch('emit', [entry.carrier, 'agent/disposed', { agent }])`
   (`packages/core/agent/src/index.ts`). Using the context as carrier routes the event to the wrong
   scope, so an agent-scoped listener never sees the agent, and the test passes without exercising
   anything. Two earlier versions of this suite were vacuous for exactly this reason.

2. **A required injection can silently disable the plugin.** The plugin injects `tools` and
   `attachments`. Omit `attachments` and `apply()` never runs: `tools: 0`, no effects, no error. A
   suite that "passes" in that state is asserting nothing.

3. **A container always has one display before anything observes.** Baseline `X1` exists at creation,
   so the first named screen adopts it. Assert relative to a measured baseline, never against a
   constant, and poll for asynchronous allocation before concluding a display was reused.

4. **`docker` needs group access.** These suites shell out through `newgrp docker` because the test
   account is not in the docker group. A silent failure there yields an empty display list, which
   would satisfy a naive "no displays" assertion — so container-gone checks are written to fail
   closed.

5. **Counts are not screens.** Two observes returning different byte counts may just be timing. The
   decisive evidence is the socket list inside the container.

## Adding a suite

Conventions the existing suites follow:

- Plain ESM `.mjs`, runnable with `node` (except the plugin suite, which needs the harness).
- A `check(name, condition, detail)` helper printing `name=ok` / `name=FAIL detail`, incrementing a
  failure counter.
- `process.exitCode = failures === 0 ? 0 : 1`, and a final line `… checks: all passed` or
  `… failed`.
- Cleanup in a way that survives a mid-suite throw, plus a final "nothing left behind" assertion.
- Never assert implementation detail: assert what a caller observes.
