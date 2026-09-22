# dsh-rakazo

Give a [DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness) agent its own
disposable Linux computer, and let several agents of one Team share one computer while each keeps
its own screen.

This repository is the integration layer between two systems:

- **Rakazo** owns machines: it provisions Docker containers, keeps a persistent workspace, suspends
  idle computers, and exposes a service-account API for programs outside its own UI.
- **DeepSeek Harness (DSH)** owns agents: sessions, tools, subagents, and Agent Teams.

The integration is three pieces, in order of trust:

```
DSH agent session
      │  native tools (bash/read/write/edit)  ──────────────┐
      │  or rakazo_* tools                                   │
      ▼                                                      ▼
  DSH plugin                                         fs/shell providers
  (plugin/index.js)                                  (providers/*.js)
      │                                                      │
      │  one bearer token: BRIDGE_TOKEN                       │
      ▼                                                      ▼
  bridge (src/*.mjs)  ── holds the Rakazo service token, keeps no state
      │
      │  one bearer token: EXTERNAL_COMPUTER_TOKEN
      ▼
  Rakazo API  ──►  Docker container (browser, filesystem, terminal, displays)
```

## Why the bridge exists

Rakazo's service token must never reach the harness process: an agent can run `bash` and read
`/proc/<pid>/environ`. So the Rakazo credential stays in the bridge, and the harness holds only a
separate `BRIDGE_TOKEN`. The bridge is a stateless credential proxy — it keeps no database, no
leases, and no state on disk.

Per-computer authorization is a **capability**, minted by the bridge when a computer is created,
held only in the plugin's memory, and compared by hash. A caller can only address a computer it
holds a capability for, so naming another session's computer fails.

## What the agent can do

Seven tools, registered by `plugin/index.js`:

| Tool | Purpose |
| --- | --- |
| `rakazo_computer_create` | Create or re-adopt this session's computer |
| `rakazo_computers` | List this session's computers, or report one's state with `computerId` |
| `rakazo_computer_exec` | Run one argv command (`bash -lc` is yours to spell out) |
| `rakazo_file` | Read or write one workspace-relative text file (`op: read \| write`) |
| `rakazo_computer_observe` | Screenshot the desktop, returned as an image |
| `rakazo_computer_browser` | Drive the browser: `navigate`, `snapshot`, `act` |
| `rakazo_computer_destroy` | Stop and delete a computer (idempotent) |

`providers/` additionally routes the harness's **native** tools into the computer, so a model can use
plain `bash`, `read`, `write`, and `edit` instead of the wrappers. See
[docs/architecture.md](docs/architecture.md) for how the two paths differ and when each applies.

## Quick start

Prerequisites: a running Rakazo with the external computer surface enabled, Docker, Node, and a
built DSH checkout. See [docs/deployment.md](docs/deployment.md) for the full walkthrough.

```sh
# 1. Bridge credentials (owner-only file, never committed)
cd /path/to/dsh-rakazo-bridge
cp .env.example .env
# fill in BRIDGE_TOKEN (openssl rand -hex 32) and RAKAZO_EXTERNAL_TOKEN
chmod 600 .env

# 2. Start the bridge
npm start                       # listens on 127.0.0.1:7400
curl -s http://127.0.0.1:7400/health

# 3. Install the plugin into a DSH profile
cd /path/to/dsh-rakazo-bridge
dsh plugin --profile web add ./dist/dsh-rakazo-computer-use/dsh-rakazo-computer-use-0.1.3.tgz
dsh --profile web --dump-config | grep -A6 rakazo-computer-use
```

Requires a Rakazo deployment with the external computer surface enabled — that is a config change on
the Rakazo side, covered in [docs/deployment.md](docs/deployment.md#step-1--enable-the-external-computer-surface-in-rakazo).

## Tests

Three suites, all against a live bridge, Rakazo, and real containers. Nothing is mocked, and every
computer a suite creates is destroyed before it finishes.

```sh
npm run test:bridge     # 27 checks — control plane, capabilities, isolation, idempotency
npm run test:screens    # 19 checks — screen naming rule, one display per screen
npm run test:plugin     # 18 checks — plugin contracts, shared Teams, disposal
npm test                # all three, in order
```

`test:bridge` and `test:screens` need only Node and the bridge env file. `test:plugin` needs the
Harness packages, so its script `cd`s into the harness checkout; override the harness path in
`package.json` if yours differs. See [docs/testing.md](docs/testing.md).

## Repository layout

```
src/                 bridge: HTTP control plane, stateless
  server.mjs         routes and request log
  computers.mjs      ownership, capabilities, per-computer serialization
  api-client.mjs     Rakazo API client (holds the service token)
  config.mjs         env and owner-only file loading
plugin/              the DSH plugin: seven tools, identity, disposal
providers/           native tool routing (fs + shell) over the same bridge
test/                the three suites
patches/             REQUIRED upstream Rakazo changes — apply these first
dist/                packaged bundle for `dsh plugin add`
docs/                architecture, deployment, testing, security
```

## Documentation

| Document | Read it for |
| --- | --- |
| [architecture.md](docs/architecture.md) | The three pieces, ownership model, identity, screens |
| [deployment.md](docs/deployment.md) | Standing this up from scratch, and operating it |
| [testing.md](docs/testing.md) | What each suite proves and how to extend them |
| [security.md](docs/security.md) | Trust boundaries, what isolation is and is not guaranteed |
| [contributing.md](docs/contributing.md) | Conventions, invariants to preserve, known gaps |
| [patches/README.md](patches/README.md) | The required upstream Rakazo changes |

## Known limitations

These are deliberate and documented rather than accidental; see
[contributing.md](docs/contributing.md#known-gaps) for the full list.

- **`keep: true` has no automatic reclamation.** With it set, a computer whose session disappears
  is never destroyed by the plugin; it waits to be re-adopted, and otherwise relies on Rakazo's own
  idle policy. The default (`keep` unset) destroys on disposal, which is what guarantees a closed
  conversation leaves no container.
- **`prune` needs a session store.** The plugin reclaims computers whose owning session no longer
  exists, but only in a composition that exposes one; without it, the plugin logs a skip and leaves
  computers alone rather than guessing.
- **Background command execution is unsupported.** Rakazo's exec route is foreground-only, so the
  shell provider's `start()` throws a descriptive error instead of fabricating a process handle.
- **A computer is one security boundary.** Teammates sharing a computer can read each other's files
  and browser sessions. That is the point of sharing, not a defect — see
  [security.md](docs/security.md).

## License

See [LICENSE](LICENSE). The bridge and plugin are original work; Rakazo and DeepSeek Harness remain
under their own licenses.
