#!/usr/bin/env bash
# Remove the pit dev workspace entirely.

set -euo pipefail

WS="${PIT_WS:-/tmp/pit-dev-ws}"

if [[ ! -d "$WS" ]]; then
  echo "pit-dev: nothing to remove at $WS"
  exit 0
fi

# Also remove any worktrees created next to the repo
for wt in "$WS/repo"-wt-*; do
  [[ -d "$wt" ]] && rm -rf "$wt" && echo "pit-dev: removed worktree $wt"
done

rm -rf "$WS"
echo "pit-dev: workspace removed"
