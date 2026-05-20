#!/usr/bin/env bash
# Tear down and recreate the pit dev workspace.
# Equivalent to: teardown.sh && setup.sh

set -euo pipefail

WS="${PIT_WS:-/tmp/pit-dev-ws}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "pit-dev: resetting workspace at $WS..."
rm -rf "$WS"
exec bash "$SCRIPT_DIR/setup.sh"
