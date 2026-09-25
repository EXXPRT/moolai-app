#!/bin/bash
set -euo pipefail
root_dir="$(cd "$(dirname "$0")/.." && pwd)"
exec node "$root_dir/scripts/start-asr.mjs"
