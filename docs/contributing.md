# Contributing

This project hands a coding agent a real computer. The conventions below exist because breaking them
has consequences that are not visible in a diff — a silently un-renewed container, a test that cannot
fail, a scope that quietly collapses two conversations onto one machine.

## Before you start

```sh
npm start                 # bridge, from a configured .env
npm test                  # 64 checks against live systems
```

You need a Rakazo deployment with the external surface enabled and Docker reachable — see
[deployment.md](deployment.md). Nothing is mocked, so a green run means the whole path works.

## Conventions

**JavaScript, not TypeScript.** The bridge and providers are plain ESM `.mjs`/`.js` so they load by
path from a DSH profile without a build step. Keep it that way: a build step between `dsh plugin add`
and a working plugin is a support burden nobody asked for.

**No private class fields in plugins/providers.** Cordis serves services through a `Proxy`, so
`#private` members are unreachable in a mounted plugin (`Cannot read private member #x from an object
whose class did not declare it`). Use plain properties.

**Comments explain why, never what.** The non-obvious parts of this code are decisions: why identity
is the caller's, why disposal is destructive by default, why a provider advertises a `sandboxMode`.
Record the reasoning where the next reader will hit it.

**Fail loudly, never silently degrade.** The failure mode that cost the most time here was a scope
lookup returning a sentinel (`"unscoped"`) that matched nothing, so a release quietly disposed
nothing. If a value cannot be established, throw. The one exception is a lifecycle event with no
caller to report to (`agent/disposed` without an identity), which returns early and says why.

**No state on disk in the bridge.** It is a credential proxy. Identity is derived, capabilities live
in memory, machine lifecycle belongs to Rakazo. There is nothing to back up and nothing to drift.

## Invariants

These hold today and are asserted by the suites. Changing one is a design decision, not a refactor:

1. **Identity is derived, never stored.** `botId = "dsh-" + scopeKey`, where the scope is the session
   id, or the Team root under `share: true`. This is what makes a harness restart re-adopt the same
   computer with no state.
2. **Capabilities gate every per-computer call**, compared by hash, never persisted, rotated on
   re-adoption.
3. **The model never chooses an identity.** `computerId` and `botId` come from code; a model-supplied
   value can only refer to something the session already owns.
4. **One computer-use provider per deployment.** The seam is exclusive by design.
5. **Disposal is destructive by default.** `keep: true` is the explicit opt-out, and it trades
   automatic cleanup for continuation.
6. **A teammate's roster exit does not end the Team's computer.** Only the principal's disposal does.
7. **Screens are namespaced under the computer's own `botId`.** Loosening this lets a caller address
   another computer's display.
8. **Both tool paths resolve to the same computer.** The plugin and the fs/shell providers must agree
   on `dsh-<scope>`, or native `bash` and `rakazo_computer_exec` silently act on different machines.

## Testing requirements

Any behavioural change needs an assertion that **fails without it**. Verify that by breaking the
behaviour on purpose:

```sh
cp plugin/index.js /tmp/plugin.bak
# introduce the regression
node /path/to/test/suite.mjs      # it MUST fail
cp /tmp/plugin.bak plugin/index.js
node /path/to/test/suite.mjs      # and pass again
```

A suite that cannot fail is worse than no suite: it converts an untested path into a false
guarantee. Four current assertions were verified this way — see
[testing.md](testing.md#falsifiability).

When adding checks, assert what a caller observes (a container's displays, a stale id's error), never
that a function was called or a field was copied.

## Known gaps

Deliberate, documented, and open to design work rather than patching:

| Gap | Consequence | Where to start |
| --- | --- | --- |
| `keep: true` has no automatic reclamation | A computer whose session disappears waits for re-adoption; otherwise Rakazo's idle policy must reclaim it | A sweeper keyed on the bridge's own list, or a Rakazo-side idle rule for external computers |
| `prune` needs a session store | Without `sessionQuery`, abandoned computers are not reclaimed (logged, not silent) | Mount `session-query` in the profile, or derive liveness differently |
| Background execution unsupported | The shell provider's `start()` throws; long jobs need a foreground command or a job runner | Rakazo would need a streaming/background exec route |
| One bridge per deployment | Several harnesses against one bridge share its computers | A per-deployment bridging layer, or scoped service accounts |
| No network or resource policy added | Isolated from the host, but not from the network | Enforce at the container/network layer |
| MCP integration removed | One integration path only | The plugin supersedes it — see the git history if you need the old shape |

## Layout, and what belongs where

```
src/         bridge. Routes, ownership, Rakazo API client, config. No DSH imports.
plugin/      the DSH plugin. No bridge internals — it talks HTTP.
providers/   native tool routing. Shares providers/bridge.js with the plugin.
test/        one file per property area; each self-cleaning.
dist/        the packaged bundle. Regenerate with `pnpm pack` after touching plugin/.
docs/        this documentation set.
```

Keep the bridge free of DSH knowledge and the plugin free of Rakazo knowledge: the bridge speaks
HTTP, the plugin speaks tools, and `providers/bridge.js` is the only shared code.

## Releasing

```sh
cp plugin/index.js dist/dsh-rakazo-computer-use/index.js
# bump version in dist/dsh-rakazo-computer-use/package.json
cd dist/dsh-rakazo-computer-use && rm -f *.tgz && pnpm pack
```

Then install the tarball into a throwaway profile to prove it is self-contained:

```sh
DSH_HOME=/tmp/verify dsh plugin --profile web add ./dsh-rakazo-computer-use-<version>.tgz
DSH_HOME=/tmp/verify dsh --profile web --dump-config | grep -A6 rakazo-computer-use
```

Never commit `.env`, a token, or a capability. `dist/` is committed deliberately so users can install
without a checkout — keep it in sync with `plugin/index.js` when that file changes.

## Submitting changes

- Keep a change to one concern. "Add screens" and "fix disposal" are two commits, not one.
- Say what you verified, and how. "Tests pass" is weaker than "this assertion failed before the fix
  and passes after".
- If you change behaviour documented here, update the document in the same commit.
