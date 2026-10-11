#!/bin/sh
# Run a command in the Android build container, e.g.
#   android/env/run.sh ./gradlew assembleDebug
#   android/env/run.sh adb devices
# With no arguments, opens a shell. The repo is mounted at /work; Gradle caches and adb keys
# live in named volumes so they survive container restarts.
set -e
CTX=colima-android
IMAGE=pad-games-android-env
ROOT=$(cd "$(dirname "$0")/../.." && pwd)

if ! docker --context $CTX info >/dev/null 2>&1; then
  colima start android >/dev/null
  docker context use colima >/dev/null 2>&1 || true # colima start switches the global context
fi
if ! docker --context $CTX image inspect $IMAGE >/dev/null 2>&1; then
  docker --context $CTX build --platform linux/amd64 -t $IMAGE "$ROOT/android/env"
fi

[ $# -eq 0 ] && set -- bash
TTY=; [ -t 0 ] && TTY=-it
exec docker --context $CTX run --rm $TTY --platform linux/amd64 \
  --network host \
  -v "$ROOT":/work \
  -v pad-games-gradle:/root/.gradle \
  -v pad-games-adb:/root/.android \
  -w /work/android \
  $IMAGE "$@"
