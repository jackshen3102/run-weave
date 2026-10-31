#!/bin/bash
set -euo pipefail
PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIGURATION=Debug
BUILD_DIR="$PACKAGE_DIR/.build"
TEAM=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --configuration|--derived-data-path|--team)
      [ "$#" -ge 2 ] || exit 2
      case "$1" in
        --configuration) CONFIGURATION="$2" ;;
        --derived-data-path) BUILD_DIR="$2" ;;
        --team) TEAM="$2" ;;
      esac
      shift 2 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
case "$CONFIGURATION" in Debug|Release) ;; *) exit 2 ;; esac
xcodegen generate --spec "$PACKAGE_DIR/project.yml"
SIGNING=(CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES)
if [ -n "$TEAM" ]; then
  SIGNING=("DEVELOPMENT_TEAM=$TEAM" "CODE_SIGN_IDENTITY=Apple Development")
else
  echo "Ad-hoc build: use --team TEAM_ID for stable screen-recording authorization." >&2
fi
xcodebuild -project "$PACKAGE_DIR/ScreenJournal.xcodeproj" -scheme ScreenJournal \
  -configuration "$CONFIGURATION" -derivedDataPath "$BUILD_DIR" "${SIGNING[@]}" build
