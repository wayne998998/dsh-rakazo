# Deployment

Standing this up from nothing. Read [architecture.md](architecture.md) first if the three pieces are
not yet clear.

## What you need

| Requirement | Notes |
| --- | --- |
| Rakazo deployment | With the external computer surface enabled (below). Docker provider is what this was built and tested against. |
| Docker | The Rakazo supervisor provisions one container per computer. Your user needs access to the Docker socket. |
| Node | `fetch` and `AbortSignal.timeout` are used directly, so Node 20+ is a safe floor. Developed on 26. |
| DeepSeek Harness | A built checkout (`apps/cli/lib/bin.js`) or an installed `dsh`. |
| OpenSSL | Only to generate tokens; any high-entropy source works. |

## Step 1 — Enable the external computer surface in Rakazo

> **This requires two patches to Rakazo that are not yet upstream.** Apply
> [`patches/`](../patches/README.md) to a Rakazo checkout first; they add the external computer API
> and the per-caller screen parameter. Both are verified to apply to `493f05c8` and to pass their
> tests on a fresh clone.

The surface is **disabled unless both values are set**, so this step is deliberate.

In the Rakazo deployment's `.env`:

```sh
EXTERNAL_COMPUTER_TOKEN=<a high-entropy secret>
EXTERNAL_COMPUTER_SPACE_ID=<the space that owns computers created this way>
```

- The token authenticates the *caller*; it is not the sandbox token. Rakazo never hands the caller
  the supervisor URL or token.
- The space id decides ownership. Every computer created through this surface belongs to it, and each
  call is re-authorized against it.
- A space also caps computers (`SANDBOX_MAX_COMPUTERS_PER_SPACE`); exceed it and creation returns
  `429 Computer limit reached for space`.

Restart the Rakazo API after setting them. Verify with:

```sh
curl -s -o /dev/null -w '%{http_code}\n' \
  -X POST http://127.0.0.1:3100/api/v1/external/computers \
  -H "authorization: Bearer $EXTERNAL_COMPUTER_TOKEN" \
  -H 'x-rakazo-bot-id: dsh-smoke' -H 'content-type: application/json' \
  -d '{"botId":"dsh-smoke"}'
# 200 means the surface is live; 404 means the surface is not mounted.
```

Destroy anything you created with that smoke test (`DELETE /api/v1/external/computers/<id>` with the
same two headers).

## Step 2 — Configure the bridge

The bridge needs three values and holds the only Rakazo service token in the system.

```sh
cd /path/to/dsh-rakazo-bridge
cat > .env <<EOF
BRIDGE_TOKEN=$(openssl rand -hex 32)
RAKAZO_EXTERNAL_TOKEN=<the EXTERNAL_COMPUTER_TOKEN from step 1>
RAKAZO_API_URL=http://127.0.0.1:3100
EOF
chmod 600 .env
```

`.env` is gitignored. The bridge reads this file by default, or whatever `BRIDGE_ENV_FILE` points at,
so secrets can live outside the checkout. Environment variables win over the file.

| Variable | Default | Meaning |
| --- | --- | --- |
| `BRIDGE_TOKEN` | — | Required. The credential the harness presents. Different from the Rakazo token. |
| `RAKAZO_EXTERNAL_TOKEN` | — | Required. The Rakazo service token. Never leaves this process. |
| `RAKAZO_API_URL` | `http://127.0.0.1:3100` | Where the Rakazo API listens. |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address. Keep it on loopback unless the harness runs elsewhere. |
| `BRIDGE_PORT` | `7400` | Listen port. |
| `BRIDGE_ENV_FILE` | `<repo>/.env` | Where to read the file above from. |

## Step 3 — Run the bridge

```sh
npm start
# or under a supervisor:
#   systemd, pm2, or a container — it is a single stateless process
```

Verify:

```sh
curl -s http://127.0.0.1:7400/health
# {"ok":true,"api":"http://127.0.0.1:3100","computers":0}
```

There is no state to back up and no migration to run. Restarting the bridge is always safe: it
forgets in-memory capability hashes, and the harness re-adopts its computers on the next create.

## Step 4 — Install the plugin into a DSH profile

Two paths. Pick one; do not mount both, since they expose the same capability twice.

**Packaged bundle** (no checkout needed):

```sh
dsh plugin --profile web add ./dist/dsh-rakazo-computer-use/dsh-rakazo-computer-use-0.1.3.tgz
```

**Local development** (edit-and-reload, no repack):

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: computer-use
      name: '@deepseek-ai/dsh-computer-use'
    - id: rakazo-computer-use
      name: '/absolute/path/to/dsh-rakazo-bridge/plugin/index.js'
      config:
        envFile: /absolute/path/to/dsh-rakazo-bridge/.env
```

Row `config` accepts:

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | `http://127.0.0.1:7400` | Bridge base URL. |
| `token` | `$BRIDGE_TOKEN` | Bridge credential; prefer the environment. |
| `envFile` | — | Read the bridge's `.env` (development shortcut). |
| `keep` | `false` | Disposal forgets instead of destroys, so the same identity re-adopts later. |
| `share` | `false` | Every teammate of one Agent Team uses that Team's computer. |

Verify the layer composed:

```sh
dsh --profile web --dump-config | grep -A6 rakazo-computer-use
```

The seam allows **one** computer-use provider per deployment. Adding a second fails with the
registered provider name, so remove any other provider row first.

## Step 5 — Optional: native tools and shared Teams

**Native `bash`/`read`/`write` inside the computer.** Mount the providers:

```yaml
- id: fs-rakazo
  name: '/absolute/path/to/dsh-rakazo-bridge/providers/fs-rakazo.js'
  config:
    envFile: /absolute/path/to/dsh-rakazo-bridge/.env
- id: shell-rakazo
  name: '/absolute/path/to/dsh-rakazo-bridge/providers/shell-rakazo.js'
  config:
    envFile: /absolute/path/to/dsh-rakazo-bridge/.env
```

These advertise a `sandboxMode`, which makes the harness require `ctx.sandboxPolicy` in the
composition. `dsh-base` already mounts it; a hand-built composition must too, or the bash tool fails
at load with `the mounted bash executor confines but ctx.sandboxPolicy is missing`.

**Shared computer per Agent Team** requires the Agent Team packages, and they replace the direct
delegation tools:

```yaml
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-subagent
  disabled: true
- id: tool-subagent-fork
  disabled: true

- insert:
    - id: rakazo-computer-use
      name: '/absolute/path/to/dsh-rakazo-bridge/plugin/index.js'
      config:
        envFile: /absolute/path/to/dsh-rakazo-bridge/.env
        share: true
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
    - id: tool-agent-team
      name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

With `share: true`, teammates read each other's files and browser sessions. That is the point of a
shared computer, and it is **not** an isolation boundary — see [security.md](security.md).

## Operating it

**Logs.** The bridge logs one line per request (`req <method> <path> <status> <ms>`) and nothing
secret. The capability is carried in a header, never the query string, so logs are safe to keep.

**Upgrades.** Pull the new code and restart the bridge. Nothing to migrate. The harness re-adopts its
computers because identity is derived, not stored.

**Reclaiming abandoned computers.** A computer whose session no longer exists is reclaimed at plugin
load, but only in a composition exposing a session store. Without one, the plugin logs
`prune skipped: no sessionQuery service in this composition` and leaves computers alone.

**Manual cleanup.** List and destroy through the bridge:

```sh
TOKEN=$(grep '^BRIDGE_TOKEN=' .env | cut -d= -f2-)
curl -s http://127.0.0.1:7400/v1/computers -H "authorization: Bearer $TOKEN"
curl -s -X DELETE http://127.0.0.1:7400/v1/computers/<id> \
  -H "authorization: Bearer $TOKEN" -H 'x-rakazo-adopt: 1'
# x-rakazo-adopt authorizes a computer this process never issued a capability for.
```

The remaining containers are also plain Docker objects, so `docker ps -a | grep rakazo-bot-` and
`docker rm -f` always work as a last resort.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `rakazo bridge token is not configured for this harness` | The row's `envFile` does not exist and `BRIDGE_TOKEN` is not in the harness environment. |
| `rakazo bridge unreachable` | The bridge is not running, or `url` points elsewhere. |
| `401 unauthorized` from the bridge | `BRIDGE_TOKEN` differs between the bridge and the caller. |
| `404` from Rakazo's external routes | The surface is disabled: `EXTERNAL_COMPUTER_TOKEN` or `EXTERNAL_COMPUTER_SPACE_ID` is unset. |
| `403 screenId does not belong to this computer` | A screen name outside the caller's own `botId` namespace. |
| `429 Computer limit reached for space` | The space's computer cap is reached; destroy unused computers. |
| `the mounted bash executor confines but ctx.sandboxPolicy is missing` | Providers are mounted in a composition without `sandbox-policy`. |
| `background processes are not supported` | Expected: Rakazo's exec route is foreground-only. Use a foreground command. |
| Plugin row loads but no tools appear | A required injection is missing (`tools`, `attachments`), so the plugin never applied. Check the boot log. |
