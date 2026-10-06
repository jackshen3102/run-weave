#!/bin/bash
set -euo pipefail
REMOTE_HOST_PACKAGE="$(cd "$(dirname "$0")" && pwd)"
REMOTE_HOST_REPOSITORY="$(cd "$REMOTE_HOST_PACKAGE/../.." && pwd)"
REMOTE_HOST_CONFIGURATION=Release
REMOTE_HOST_TEAM=""
REMOTE_HOST_OUTPUT="$REMOTE_HOST_REPOSITORY/.runweave/remote-desktop-implementation/HostDerivedData"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --configuration|--team|--derived-data-path)
      if [ "$#" -lt 2 ] || [[ "$2" == --* ]]; then echo "Missing value for $1" >&2; exit 2; fi
      case "$1" in
        --configuration) REMOTE_HOST_CONFIGURATION="$2" ;;
        --team) REMOTE_HOST_TEAM="$2" ;;
        --derived-data-path) REMOTE_HOST_OUTPUT="$2" ;;
      esac
      shift 2 ;;
    *) echo "Usage: build-host.sh [--configuration Debug|Release] [--team TEAM_ID] [--derived-data-path PATH]" >&2; exit 2 ;;
  esac
done
case "$REMOTE_HOST_CONFIGURATION" in Debug|Release) ;; *) exit 2 ;; esac
command -v xcodegen >/dev/null
xcodegen generate --spec "$REMOTE_HOST_PACKAGE/project.yml"
REMOTE_HOST_SIGNING=(CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES)
if [ -n "$REMOTE_HOST_TEAM" ]; then REMOTE_HOST_SIGNING=("DEVELOPMENT_TEAM=$REMOTE_HOST_TEAM"); fi
xcodebuild -project "$REMOTE_HOST_PACKAGE/RunweaveRemoteHost.xcodeproj" \
  -scheme RunweaveRemoteHost -configuration "$REMOTE_HOST_CONFIGURATION" \
  -derivedDataPath "$REMOTE_HOST_OUTPUT" "${REMOTE_HOST_SIGNING[@]}" build
printf '%s\n' "$REMOTE_HOST_OUTPUT/Build/Products/$REMOTE_HOST_CONFIGURATION/RemoteDesk.app"
