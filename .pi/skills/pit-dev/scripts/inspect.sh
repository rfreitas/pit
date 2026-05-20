#!/usr/bin/env bash
# Inspect the current state of the pit dev workspace.
# Shows: git branches, worktrees, and sessions.

set -euo pipefail

WS="${PIT_WS:-/tmp/pit-dev-ws}"

if [[ ! -d "$WS/repo" ]]; then
  echo "pit-dev: no workspace at $WS — run setup.sh first"
  exit 1
fi

echo "=== git branches ($WS/repo) ==="
git -C "$WS/repo" branch -v 2>/dev/null || echo "(none)"

echo ""
echo "=== git worktrees ==="
git -C "$WS/repo" worktree list 2>/dev/null || echo "(none)"

echo ""
echo "=== sessions ($WS/agent/sessions) ==="
find "$WS/agent/sessions" -name "*.jsonl" 2>/dev/null \
  | sort \
  | while read -r f; do
      bucket=$(basename "$(dirname "$f")")
      ts=$(basename "$f" .jsonl | cut -c1-19)
      cwd=$(head -1 "$f" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('cwd','?'))" 2>/dev/null || echo "?")
      echo "  [$ts] $cwd"
      echo "        $f"
    done
