# dsh-rakazo

**Give an AI agent a computer of its own.**

This connects [Rakazo](https://github.com/elie222/rakazo)'s machine management to the
[DeepSeek Harness](https://github.com/deepseek-harness/deepseek-harness), so an agent session gets a
disposable Linux desktop: run commands, read and write files, look at the screen, drive a browser —
and it is destroyed when the session is done. Several agents of one Team can share a single computer
while each keeps its own screen.

The problem it actually solves is **ownership and authorization**, not "another exec wrapper":

- **Identity is derived, not remembered.** `botId = "dsh-" + scope`, where the scope is the session id
  — or the Team root when sharing. A restarted harness re-adopts the same computer on its own: no
  state file, no leases, no heartbeats, no sweeper. Those mechanisms were removed because they are the
  part that breaks by itself, and one of them did: a computer whose lease silently stopped renewing
  was reclaimed while its session was still live.
- **Boundaries are drawn in credentials.** Three tokens, deliberately not interchangeable: the harness
  process holds only `BRIDGE_TOKEN`; Rakazo's service token stays in a stateless proxy process; the
  sandbox supervisor token is never handed out. The reason is blunt — **an agent can read its own
  environment**, so `bash` can read `/proc/<pid>/environ`. Per-computer authorization is a capability:
  minted by the proxy, stored only as a hash, held in the plugin's memory. Knowing another session's
  computer id buys you nothing.
- **Sharing is a stated trade-off, in three steps.** By default one computer per conversation. With
  `share: true`, the agents of one Team use the same computer while each gets its own screen (Rakazo
  keys a display per screen identity; three observers really do produce three Xvfb instances). With
  `account: <name>`, *every* conversation shares one long-lived machine, which is what reproduces a
  persistent team computer: same files, same browser logins, across conversations. Each step trades
  isolation for continuity, and the last one gives up cross-conversation isolation entirely — so the
  docs say it plainly: *do not put a credential on a shared computer that another conversation must
  not use. A shared computer is not a security boundary.*

Two things this project cares about more than features:

**Complexity belongs with whoever understands it.** Machine lifecycle, workspace checkpointing, and
idle suspension are Rakazo's job. This layer does ownership and authorization, and nothing else.

**Claims need falsifiable evidence.** Every check runs against real Rakazo and real containers, and
each load-bearing assertion was verified by deliberately breaking the behaviour — making `destroy`
report success without deleting, removing screen naming, reinstating the flawed shared-mode guard — to
confirm the check actually fails. That discipline also caught two of the author's own tests that could
never fail, one of which had been propping up a wrong "this is fixed" conclusion.

## Getting started

**[QUICKSTART.md](QUICKSTART.md)** — a running integration in about fifteen minutes, including the two
steps people most often get wrong: Rakazo needs [two patches](patches/README.md) that are not
upstream, and `pnpm --filter @rakazo/db generate` is not optional.

For the full walkthrough, every configuration option, and an operating guide, use
[docs/deployment.md](docs/deployment.md).

## How it fits together

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
RAKAZO_ENV_FILE=/path/to/rakazo/.env npm run test:bridge   # 27 checks — control plane
RAKAZO_ENV_FILE=/path/to/rakazo/.env npm run test:screens  # 19 checks — one display per screen
DSH_HARNESS=/path/to/deepseek-harness npm run test:plugin  # 18 checks — plugin contracts
```

`test:bridge` and `test:screens` need Node, this repo's `.env`, and `RAKAZO_ENV_FILE` pointing at
the Rakazo deployment's `.env`. `test:plugin` additionally needs a Harness checkout, because the
harness packages resolve only under its own module graph. Each suite destroys every computer it
creates and asserts nothing was left behind. See [docs/testing.md](docs/testing.md).

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
| [QUICKSTART.md](QUICKSTART.md) | The shortest path to a working install, and the two common traps |
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
