#!/usr/bin/env bash
# eas-deploy-pixel.sh — kick off `eas build --local --profile production`,
# fail fast if the determined versionCode won't install on the device,
# install + run perf-suite if it will.
#
# Why fail-fast: eas-cli prints "Incrementing versionCode from N to M"
# in the [CONFIGURE_ANDROID_VERSION] phase, which runs ~60 seconds into
# a 20-minute build. If M is less than the device's current versionCode,
# the install at the end of the build will fail with
# INSTALL_FAILED_VERSION_DOWNGRADE — so detect at line ~20 of the log
# and abort, saving ~19 min.
#
# Env overrides:
#   PIXEL_SERIAL — adb device serial (default: Ben's Pixel)
#   PACKAGE      — Android package id (default: com.lightningpiggy.app)
set -uo pipefail

# Locate the repo root from the script's location instead of hardcoding —
# scripts/eas-deploy-pixel.sh ⇒ repo root is one dir up.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

PIXEL=${PIXEL_SERIAL:-37111FDJH0067B}
PACKAGE=${PACKAGE:-com.lightningpiggy.app}
LOG_DIR=/tmp
BUILD_LOG="$LOG_DIR/eas-deploy-pixel-build.log"
EAS_TMPDIR="$HOME/eas-tmp"

# Make sure the disk-backed TMPDIR exists. Required because /tmp is tmpfs (12 GB
# cap on stock Ubuntu) and the EAS local builder writes ~9 GB of native-lib
# intermediates per build. See docs/TROUBLESHOOTING.adoc.
mkdir -p "$EAS_TMPDIR"

DEVICE_VC=$(adb -s "$PIXEL" shell dumpsys package "$PACKAGE" 2>/dev/null | grep -oP 'versionCode=\K\d+' | head -1)
echo "device $PIXEL has $PACKAGE versionCode=$DEVICE_VC"
[ -z "$DEVICE_VC" ] && { echo "could not read device versionCode — is the device connected?"; exit 1; }

# Keep the screen on while we deploy + run the perf suite. The phone
# defaults to a 30 s – 2 min lock timeout; if it locks mid-flow, the
# `adb install` reauth prompt is missed and Maestro / dumpsys gfxinfo
# stop receiving events. `stayon true` is per-session (resets on
# reboot); we restore it on EXIT below. See docs/TROUBLESHOOTING.adoc.
PRIOR_STAYON=$(adb -s "$PIXEL" shell dumpsys power 2>/dev/null | grep -oP 'mStayOn=\K\w+' | head -1)
echo "stayon: was=$PRIOR_STAYON; setting to true for the deploy + perf run"
adb -s "$PIXEL" shell svc power stayon true 2>/dev/null || true
trap 'echo "restoring stayon=${PRIOR_STAYON:-false}"; adb -s "$PIXEL" shell svc power stayon ${PRIOR_STAYON:-false} 2>/dev/null || true' EXIT

echo "starting eas build --local in background (logs: $BUILD_LOG)"
# `setsid` puts the build in its own process group so we can kill the whole
# tree later (eas-cli spawns npm, npx, java/gradle — a plain kill on the
# parent leaves them as cpu-burning orphans).
setsid bash -c "TMPDIR=\"$EAS_TMPDIR\" eas build --local --profile production --platform android --non-interactive" >"$BUILD_LOG" 2>&1 &
BUILD_PID=$!
echo "build PID=$BUILD_PID (process group $BUILD_PID)"

# Helper: kill the build's process group cleanly. Detached gradle / kotlin
# daemons may survive (they're in their own pgroups, with idle-shutdown
# timers); we deliberately do NOT pkill them globally because that would
# also nuke any unrelated Android-Studio / VSCode-Java sessions on the
# same machine.
kill_build_tree() {
  kill -TERM -- -"$BUILD_PID" 2>/dev/null
  sleep 2
  kill -KILL -- -"$BUILD_PID" 2>/dev/null
  true
}

# If the user Ctrl-Cs / SIGTERMs the wrapper, take the build down with us.
# Without this trap a Ctrl-C would leave the detached EAS pipeline + gradle
# burning CPU + filling disk for the rest of the build.
trap 'echo "[$(date +%T)] interrupted — killing build tree"; kill_build_tree; exit 130' INT TERM HUP

# Phase 1: watch for the versionCode determination, fail fast if too low.
# eas-cli emits "Version code: NN" within the first ~1% of the build (~60s).
echo "phase 1: waiting up to 5 min for versionCode determination"
TIMEOUT=$((SECONDS + 300))
NEW_VC=
while [ $SECONDS -lt $TIMEOUT ]; do
  NEW_VC=$(grep -oP 'Version code: \K\d+' "$BUILD_LOG" 2>/dev/null | head -1)
  [ -n "$NEW_VC" ] && break
  kill -0 "$BUILD_PID" 2>/dev/null || { echo "build exited before versionCode line"; tail -20 "$BUILD_LOG"; exit 1; }
  sleep 10
done

if [ -z "$NEW_VC" ]; then
  echo "TIMEOUT — no versionCode line in 5 min. killing build."
  kill_build_tree
  exit 1
fi

echo "build will produce versionCode=$NEW_VC (device has $DEVICE_VC)"
if [ "$NEW_VC" -le "$DEVICE_VC" ]; then
  echo "ABORT — $NEW_VC <= $DEVICE_VC, install would fail with VERSION_DOWNGRADE"
  echo "killing build to save ~19 min"
  kill_build_tree
  exit 2
fi

# Phase 2: build is going to produce an installable APK. Wait for it.
echo "versionCode OK — letting build complete"
wait "$BUILD_PID"
BUILD_RC=$?
[ $BUILD_RC -ne 0 ] && { echo "build failed rc=$BUILD_RC"; tail -30 "$BUILD_LOG"; exit $BUILD_RC; }

# The production profile builds one APK per ABI, which EAS packs into
# build-<timestamp>.tar.gz. The Pixel takes the arm64-v8a one.
ARCHIVE=$(ls -1t build-*.tar.gz 2>/dev/null | head -1)
[ -z "$ARCHIVE" ] && { echo "no build-*.tar.gz produced"; exit 1; }
APK_DIR="${ARCHIVE%.tar.gz}"
mkdir -p "$APK_DIR"
tar -xzf "$ARCHIVE" -C "$APK_DIR"
APK=$(find "$APK_DIR" -type f -name 'app-arm64-v8a-release.apk' | head -1)
[ -z "$APK" ] && { echo "no arm64-v8a APK in $ARCHIVE"; exit 1; }
echo "APK = $APK"

echo "installing on $PIXEL"
# adb install can return 0 on transport errors (e.g. "device offline") and
# its app-level failures show up only in stdout as "Failure …" or
# "INSTALL_FAILED_…". Check both rc and stdout.
INSTALL_OUT=$(adb -s "$PIXEL" install -r "$APK" 2>&1)
INSTALL_RC=$?
echo "$INSTALL_OUT"
if [ $INSTALL_RC -ne 0 ] || echo "$INSTALL_OUT" | grep -qiE "Failure|INSTALL_FAILED|^error:|adb: device .* not found|device offline"; then
  echo "install failed (rc=$INSTALL_RC) — not running perf-suite"
  exit 3
fi

NEW_DEVICE_VC=$(adb -s "$PIXEL" shell dumpsys package "$PACKAGE" | grep -oP 'versionCode=\K\d+' | head -1)
echo "device now reports versionCode=$NEW_DEVICE_VC"

echo "perf-suite"
# perf-suite.sh reads DEVICE + PKG from env (per scripts/perf-suite.sh:39-41).
# Don't pass SERIAL / PACKAGE — those are this wrapper's names, not its.
DEVICE="$PIXEL" PKG="$PACKAGE" bash scripts/perf-suite.sh
