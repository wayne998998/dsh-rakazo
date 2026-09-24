#!/usr/bin/env bash
# Verify a Rakazo checkout can serve the external computer API.
#
# The surface is not upstream: it arrives from the two patches in ../patches/.
# A checkout without them still builds and starts, and only fails much later as
# a bare `404` from the bridge — which reads like a configuration problem
# rather than a missing patch. So check the source before starting anything.
#
# Usage: scripts/check-rakazo-checkout.sh [path-to-rakazo]   (default $RAKAZO_DIR)
set -euo pipefail

rakazo="${1:-${RAKAZO_DIR:-}}"
if [[ -z "$rakazo" ]]; then
  echo "usage: $0 <path-to-rakazo-checkout>   (or set RAKAZO_DIR)" >&2
  exit 2
fi
if [[ ! -d "$rakazo/.git" ]]; then
  echo "not a git checkout: $rakazo" >&2
  exit 2
fi

fail=0
note() { printf '  %-46s %s\n' "$1" "$2"; }

echo "checking $rakazo"

# 1. The two source changes the patch series adds.
if [[ -f "$rakazo/apps/api/src/external-computers.ts" ]]; then
  note "external-computers.ts" "present"
else
  note "external-computers.ts" "MISSING"
  fail=1
fi

if grep -q 'screenId' "$rakazo/packages/adapter-kit/src/types.ts" 2>/dev/null; then
  note "AdapterContext.screenId" "present"
else
  note "AdapterContext.screenId" "MISSING"
  fail=1
fi

# 2. It must be mounted, or the file existing proves nothing.
if grep -q 'mountExternalComputerRoutes' "$rakazo/apps/api/src/app.ts" 2>/dev/null; then
  note "route mount in app.ts" "present"
else
  note "route mount in app.ts" "MISSING"
  fail=1
fi

# 3. Neither credential alone enables the surface.
env_file="$rakazo/.env"
for key in EXTERNAL_COMPUTER_TOKEN EXTERNAL_COMPUTER_SPACE_ID; do
  if [[ -f "$env_file" ]] && grep -qE "^${key}=.+" "$env_file"; then
    note "$key" "set"
  else
    note "$key" "unset (surface stays disabled)"
    fail=1
  fi
done

printf '\n'
if [[ "$fail" -ne 0 ]]; then
  cat >&2 <<'MSG'
This checkout cannot serve the external computer API.

If the source files are missing, the patch series is not applied. Do either:

  # take the prepared branch (recommended; kept level with upstream)
  git -C <path-to-rakazo> checkout external-computer-api

  # or apply the patches onto your own branch
  git -C <path-to-rakazo> am <this repo>/patches/*.patch
  pnpm --filter @rakazo/db generate     # required, or unrelated suites fail

If only the credentials are unset, add both to <path-to-rakazo>/.env and restart.
See <this repo>/patches/README.md for the details.
MSG
  exit 1
fi

echo "ok: this checkout can serve the external computer API"
