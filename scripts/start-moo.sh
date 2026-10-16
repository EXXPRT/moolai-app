#!/bin/bash
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
cd "$root_dir"
# Optional machine-specific entry; kept in the ignored local data directory.
if [[ -f "$root_dir/.data/start-moo.local.mjs" ]]; then
  exec node "$root_dir/.data/start-moo.local.mjs"
fi
exec node "$root_dir/scripts/start-moo.mjs"
