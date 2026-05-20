#!/usr/bin/env bash
# Create a persistent pit dev workspace at $PIT_WS (default: /tmp/pit-dev-ws).
# Safe to run multiple times — skips if already set up.
#
# After running, the workspace contains:
#   $PIT_WS/repo/    — a real git repo with one commit
#   $PIT_WS/agent/   — agent dir with empty auth.json (zero LLM cost)
#
# Use $PIT_WS/env to source workspace vars into your shell:
#   source $PIT_WS/env

set -euo pipefail

WS="${PIT_WS:-/tmp/pit-dev-ws}"

if [[ -d "$WS/repo" && -d "$WS/agent" ]]; then
  echo "pit-dev: workspace already exists at $WS"
  echo "  run teardown.sh to remove it, or reset.sh to recreate"
  cat "$WS/env"
  exit 0
fi

mkdir -p "$WS/repo" "$WS/agent/sessions"

# Minimal git repo
git -C "$WS/repo" init -b main -q
git -C "$WS/repo" -c user.email=pit-dev@test -c user.name="pit dev" \
  commit --allow-empty -qm "init"

# Empty auth so pi never makes real LLM calls
echo '{}' > "$WS/agent/auth.json"

# Env file for easy sourcing
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PIT_SCRIPT="$(cd "$SCRIPT_DIR/../../../../pit" && pwd)/pit.ts"

cat > "$WS/env" <<EOF
export PIT_WS="$WS"
export PIT_SCRIPT="$PIT_SCRIPT"
export PI_CODING_AGENT_DIR="$WS/agent"
export PI_SKIP_VERSION_CHECK=1
EOF

echo "pit-dev: workspace created at $WS"
echo ""
cat "$WS/env"
echo ""
echo "Source the env and then run pit from the repo:"
echo "  source $WS/env && cd \$PIT_WS/repo"
echo "  node --experimental-strip-types \$PIT_SCRIPT --mode json \"hello\" 2>/dev/null | head -1"
