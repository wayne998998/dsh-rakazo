# Upstream patches

This integration needs two changes in Rakazo itself. They are not in any released version as of this
writing, so apply them to a Rakazo checkout before standing the bridge up.

```
patches/
  0001-Add-a-service-account-computer-API-for-external-agen.patch    (783 lines)
  0002-feat-computer-let-one-computer-serve-a-screen-per-ca.patch    (8 lines)
```

Both are based on `5dc3f824` (`fix(adapters): preserve allOf tool schemas through Pi conversion (#970)`),
which is upstream `main` as of this writing. They apply cleanly there with no conflicts, and the
rebased tree passes the full API suite (390 checks) plus the adapter and supervisor suites (82).

## Two ways to get them

**As files** (what this directory holds): apply them to your own checkout, as below. Self-contained,
no fork needed.

**As a branch** (with full history, for reading or rebasing):

```sh
git clone --branch external-computer-api https://github.com/wayne998998/rakazo.git
git log --oneline -3
# 599336d7 feat(computer): let one computer serve a screen per caller
# 8998c2ec Add a service-account computer API for external agent harnesses
# 5dc3f824 fix(adapters): preserve allOf tool schemas through Pi conversion (#970)
```

That fork tracks upstream Rakazo on `main`, so the branch can be rebased onto a newer base with
`git rebase main external-computer-api` when upstream moves.

## What each patch does

### 0001 — the external computer API

Adds a service-account surface at `/api/v1/external/computers` so a program outside Rakazo can
obtain and drive a computer without ever receiving the sandbox supervisor URL or token. It covers
provision, exec, file read/write, observe, browser, stop, and destroy, and it is **disabled unless
both** `EXTERNAL_COMPUTER_TOKEN` and `EXTERNAL_COMPUTER_SPACE_ID` are set.

Before this patch Rakazo had no such surface: its API only exposed computer *status* for its own
web/desktop clients. Without it, the only way to reach a computer was the supervisor directly, which
would put the supervisor token inside the harness process — where an agent with `bash` can read it.

### 0002 — per-caller screens

Lets one computer serve a separate display per caller. Rakazo already keys a display by a screen
identity (`screenKey = screenId || botId || id`) and already allocates one per bot, but the external
route could only supply one identity, so a shared computer had exactly one screen.

The patch adds an optional `screenId` to `AdapterContext`, sends it as `x-rakazo-screen-id` in
preference to the computer's botId, and accepts it on the external routes. **Callers that name no
screen behave exactly as before.** Screen names are namespaced under the caller's own `botId` (it
must equal that botId or begin with `botId-`), so a caller can never address another computer's
display; anything else is refused with `403 screenId does not belong to this computer`.

## Applying them

```sh
git clone https://github.com/elie222/rakazo.git
cd rakazo
git checkout 5dc3f824                 # the patches' base

# git am needs a committer identity; set one or pass it inline
git -c user.name="you" -c user.email="you@example.com" am \
  /path/to/dsh-rakazo-bridge/patches/*.patch

git log --oneline -3
# <sha> feat(computer): let one computer serve a screen per caller
# <sha> Add a service-account computer API for external agent harnesses
# 5dc3f824 fix(adapters): preserve allOf tool schemas through Pi conversion (#970)
```

If `git am` reports a conflict, upstream has moved past `5dc3f824`. Either reset to that commit, or apply with
`git apply -3` and resolve — the surface is self-contained (`apps/api/src/external-computers.ts`,
plus a mount in `app.ts` and two env keys), so conflicts should be mechanical.

## After applying

```sh
pnpm install
pnpm --filter @rakazo/db generate     # required: the API imports the generated Prisma client
```

Then set `EXTERNAL_COMPUTER_TOKEN` and `EXTERNAL_COMPUTER_SPACE_ID` as described in
[../docs/deployment.md](../docs/deployment.md#step-1--enable-the-external-computer-surface-in-rakazo).

## Verifying the patches independently

This was verified on a fresh clone, not on the development tree:

```sh
git clone <rakazo> /tmp/verify && cd /tmp/verify
git reset --hard 5dc3f824 && git clean -fd
git -c user.name=t -c user.email=t@localhost am <patches>/*.patch
pnpm install && pnpm --filter @rakazo/db generate

npx vitest run apps/api/src                                       # 390 passed (30 files)
npx vitest run packages/adapters/src/docker-sandbox.test.ts       # 21 passed
npx vitest run infra/sandboxes/supervisor/src/computer-spec.test.ts # 61 passed
```

The `db generate` step is not optional: skipping it fails unrelated suites with
`Cannot find module './generated/prisma/client.js'`, which looks like a broken patch but is only a
missing prerequisite.

## Contributing upstream

Both patches are self-contained and argument-complete, so they are reasonable pull requests against
Rakazo: the first adds a surface, the second extends one parameter through three layers with a
scoping rule and tests. If you send them upstream and they land, this directory can be deleted and
the deployment docs simplified to "use Rakazo ≥ the release that includes them".
