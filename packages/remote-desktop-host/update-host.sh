#!/bin/bash
set -euo pipefail
REMOTE_HOST_PACKAGE="$(cd "$(dirname "$0")" && pwd)"
exec node "$REMOTE_HOST_PACKAGE/tools/update-host.mjs" "$@"
