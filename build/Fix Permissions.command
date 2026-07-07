#!/bin/bash
#
# Moon Code — Fix Permissions helper
#
# macOS quarantines apps that aren't notarized with an Apple Developer account,
# which produces the "Moon Code is damaged and can't be opened" warning.
# This script clears that quarantine flag so the app opens normally.
#
# Double-click this file to run it. (The first time, you may need to
# right-click it and choose "Open", since it is quarantined too.)

set -euo pipefail

APP_NAME="Moon Code.app"

echo "Moon Code — Fix Permissions"
echo "==========================="
echo

# Look for the app in the usual places, then fall back to alongside this script.
CANDIDATES=(
  "/Applications/${APP_NAME}"
  "${HOME}/Applications/${APP_NAME}"
  "$(cd "$(dirname "$0")" && pwd)/${APP_NAME}"
)

APP_PATH=""
for candidate in "${CANDIDATES[@]}"; do
  if [ -d "$candidate" ]; then
    APP_PATH="$candidate"
    break
  fi
done

if [ -z "$APP_PATH" ]; then
  echo "Could not find ${APP_NAME}."
  echo "Please drag Moon Code into your Applications folder first, then run this again."
  echo
  read -r -p "Press Return to close..." _
  exit 1
fi

echo "Found: $APP_PATH"
echo "Clearing quarantine flag..."

if xattr -cr "$APP_PATH"; then
  echo
  echo "Done! You can now open Moon Code normally."
else
  echo
  echo "Something went wrong. You can run this manually in Terminal:"
  echo "  xattr -cr \"$APP_PATH\""
fi

echo
read -r -p "Press Return to close..." _
