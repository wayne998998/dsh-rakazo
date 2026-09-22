# Security

What this integration protects, what it does not, and why the boundaries sit where they do. Read this
before widening any of them.

## Trust boundaries

```
harness process  ── holds BRIDGE_TOKEN only
      │              (an agent here can run bash and read /proc/<pid>/environ)
      ▼
bridge process   ── holds EXTERNAL_COMPUTER_TOKEN
      │              (never exposed to a caller, never logged)
      ▼
Rakazo API       ── holds the sandbox supervisor URL and token
      │
      ▼
container        ── the actual security boundary
```

Three credentials, deliberately not interchangeable:

| Credential | Held by | Grants |
| --- | --- | --- |
| `BRIDGE_TOKEN` | the harness process | Access to the bridge, i.e. to computers this deployment created |
| `EXTERNAL_COMPUTER_TOKEN` | the bridge process | Computer lifecycle within one configured space |
| Rakazo's sandbox supervisor token | Rakazo only | Raw provider access; never handed to a caller |

The reason for the middle layer: an agent with shell access can read its own environment. If the
Rakazo service token lived in the harness process, a prompt-injected agent could read it and act
against Rakazo's API directly. Keeping it in the bridge means the worst a leaked `BRIDGE_TOKEN` buys
is what the bridge already offers — and that is capability-gated per computer.

## Capabilities

A capability is the only thing that authorizes operations on a computer.

- Minted by the bridge at create time, returned once. Never logged, never persisted.
- Stored by the bridge as a SHA-256; the plaintext cannot be recovered from disk, because nothing is
  written to disk at all.
- Held by the plugin in memory, per session.
- Compared by hash on every call.

Consequences that are load-bearing:

- **Naming another session's computer does not reach it.** You need its capability.
- **A restart forgets capabilities.** Re-adoption mints a new one; the old value stops working.
- **Two teammates sharing a computer share one capability**, because they share a scope. Within a
  Team this is intended (below); across Teams the scopes differ and neither can reach the other.

## Shared computers are not a security boundary

With `share: true` every teammate of one Agent Team uses the same computer: the same filesystem, the
same browser sessions, the same logins. A teammate can read what another teammate wrote.

This is the design, not an oversight — it is what makes a handoff work at all. It is exactly the
model Rakazo documents for team computers: separate work surfaces, not separate security boundaries.
The corollary is stated plainly so nobody relies on the wrong thing:

> Do not put a credential on a shared computer that another teammate must not use.

Leave `share` unset when conversations must be isolated from one another. The default is one computer
per session, and that isolation is enforced by capability and by scope.

## What a computer isolates you from

The container is the boundary between the agent and your host:

- Commands run inside it; `/etc/passwd` on the host is not reachable through the file tools (the
  provider rejects absolute paths and `..`, mapping them to `FS_SANDBOX_DENIED`).
- Browser and desktop state live inside it.
- Destroying it removes the container.

What it does **not** give you:

- **No network policy.** A computer can reach whatever the Docker network allows. If the agent must
  not reach an internal service, that has to be enforced at the network layer.
- **No resource ceiling by default.** Containers are capped by whatever the Rakazo deployment
  configures; this integration adds none of its own.
- **No defense against a malicious Rakazo provider.** The bridge trusts Rakazo to tell the truth about
  identity and lifecycle. A compromised Rakazo API is outside this threat model.

## Input validation

Every boundary validates before acting, and the suites assert it:

| Input | Rule |
| --- | --- |
| `botId` | `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` |
| `computerId`, `screenId` | same identifier rule |
| Filesystem path | workspace-relative; absolute paths and `..` rejected |
| `argv` | non-empty array of non-empty strings; no shell interpolation |
| `timeoutMs` | integer within 1 000–300 000 |
| File content | ≤ 16 MiB |
| Request body | ≤ 16 MiB |

`exec` takes an argv array, so a caller cannot smuggle shell metacharacters through a quoted string:
whatever runs is what was listed. The plugin wraps commands for the *native* shell path explicitly
(`["bash","-lc",command]`) because that path is a shell by definition.

## Secret handling rules

Follow these when changing anything:

1. **Never commit a token.** `.env` is gitignored; use `.env.example` for names only.
2. **Never log a credential.** The bridge logs method, path, status, and duration. Capabilities travel
   in headers precisely so they stay out of query strings, logs, and referrers.
3. **Never return a capability from a listing.** `GET /v1/computers` reports identity and state only.
4. **Never widen a screen's namespace.** A screen id must equal the caller's `botId` or start with
   `botId-`, checked server-side in Rakazo. Anything looser lets a caller address another computer's
   display.
5. **Keep `chmod 600` on `.env`.** The bridge reads it as the deployment user; nothing else needs it.

## Reporting a problem

If you find a way to reach a computer without its capability, to escape the container's workspace
through the file tools, or to obtain a token you should not hold, treat it as a security issue: do
not open a public issue with a working exploit. Describe the class of problem and a way to reach the
maintainer privately.

## Not in scope

- Hardening Rakazo itself, or its sandbox providers.
- Multi-tenant isolation between *deployments*: one bridge serves one Rakazo deployment. Running
  several harnesses against one bridge means they share the deployment's computers, which is a
  deployment decision, not something this code enforces.
- Prompt-injection resistance inside an agent's own reasoning. The boundary here is what an agent can
  *do*, given it will sometimes be wrong.
