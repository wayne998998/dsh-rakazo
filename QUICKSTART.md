# Quick start

Get a running integration in about fifteen minutes. The long form, with reasoning and every option,
is in [docs/deployment.md](docs/deployment.md); this page is the shortest path that works.

Two things are easy to get wrong and cost the most time:

- **Rakazo needs two patches first.** They are not upstream. Without them there is no API to talk to,
  so nothing else can work.
- **`pnpm --filter @rakazo/db generate` is required.** Skipping it makes unrelated tests fail with a
  missing Prisma client, which looks like a broken patch.

## What you need

| | |
| --- | --- |
| Rakazo checkout | plus the two patches in [`patches/`](patches/README.md) |
| Docker | reachable by your user; the supervisor provisions containers |
| Node 20+ | `fetch` and `AbortSignal.timeout` are used directly |
| DeepSeek Harness | a built checkout, for the plugin and its tests |

## 1. Patch Rakazo

```sh
git clone https://github.com/elie222/rakazo.git
cd rakazo
git checkout 5dc3f824                                   # the patches' base

git -c user.name="you" -c user.email="you@example.com" am \
  /path/to/dsh-rakazo/patches/*.patch
```

`git am` refuses to run without a committer identity; that is what the inline config is for.

## 2. Install and generate

```sh
pnpm install
pnpm --filter @rakazo/db generate     # required — see the note above
```

## 3. Enable the external computer surface

In the Rakazo deployment's `.env`:

```sh
EXTERNAL_COMPUTER_TOKEN=<openssl rand -hex 32>
EXTERNAL_COMPUTER_SPACE_ID=<the space that owns these computers>
```

**Both** are required; with either missing the surface returns 404 and looks unconfigured. Restart the
Rakazo API, then check:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:3100/api/v1/external/computers \
  -H "authorization: Bearer $EXTERNAL_COMPUTER_TOKEN" \
  -H 'x-rakazo-bot-id: dsh-smoke' -H 'content-type: application/json' \
  -d '{"botId":"dsh-smoke"}'
# 200 = live, 404 = the surface is not mounted
```

## 4. Start the bridge

```sh
cd /path/to/dsh-rakazo
cp .env.example .env
# fill in BRIDGE_TOKEN (openssl rand -hex 32) and
# RAKAZO_EXTERNAL_TOKEN (the value from step 3)
chmod 600 .env
npm start
```

```sh
curl -s http://127.0.0.1:7400/health
# {"ok":true,"api":"http://127.0.0.1:3100","computers":0}
```

## 5. Install the plugin

```sh
dsh plugin --profile web add /path/to/dsh-rakazo/dist/dsh-rakazo-computer-use/dsh-rakazo-computer-use-0.1.3.tgz
dsh --profile web --dump-config | grep -A6 rakazo-computer-use
```

That should print a `dsh-rakazo-computer-use` layer with the bridge URL. Start `dsh` and the agent has
seven `rakazo_*` tools.

## 6. Prove it works

```sh
cd /path/to/dsh-rakazo
RAKAZO_ENV_FILE=/path/to/rakazo/.env npm run test:bridge     # 27 checks
RAKAZO_ENV_FILE=/path/to/rakazo/.env npm run test:screens    # 19 checks
DSH_HARNESS=/path/to/deepseek-harness npm run test:plugin    # 18 checks
DSH_HARNESS=/path/to/deepseek-harness npm run test:account   # 13 checks
```

Each suite destroys the computers it creates. If these pass, the whole path works end to end.

## Where to go next

| Want to | Read |
| --- | --- |
| Understand the design | [docs/architecture.md](docs/architecture.md) |
| Share one computer across a Team | [docs/deployment.md](docs/deployment.md#step-5--optional-native-tools-and-shared-teams) |
| Keep one computer across conversations | [docs/deployment.md](docs/deployment.md#step-5--optional-native-tools-and-shared-teams) (`account`) |
| Use plain `bash`/`read`/`write` instead of wrappers | same section (`providers/`) |
| Know what is guaranteed and what is not | [docs/security.md](docs/security.md) |
| Contribute | [docs/contributing.md](docs/contributing.md) |

## When it does not work

| Symptom | Cause |
| --- | --- |
| `404` from Rakazo's external routes | `EXTERNAL_COMPUTER_TOKEN` or `EXTERNAL_COMPUTER_SPACE_ID` unset |
| `Cannot find module './generated/prisma/client.js'` | step 2 was skipped |
| `rakazo bridge token is not configured` | `.env` missing, or the row's `envFile` does not point at it |
| `401 unauthorized` from the bridge | `BRIDGE_TOKEN` differs between bridge and caller |
| `error: could not apply …` during `git am` | upstream moved past `5dc3f824`; reset to it or use `git apply -3` |
| Tools do not appear in a session | the plugin never applied — a required injection (`tools`, `attachments`) is missing from the composition |

The full troubleshooting table is in [docs/deployment.md](docs/deployment.md#troubleshooting).
