#!/usr/bin/env bash
# Enforce the mechanically-greppable subset of the performance authoring rules
# (CLAUDE.md → Performance rules; docs/PERFORMANCE.adoc → Authoring best
# practices). Two checks:
#
#   1. Per-event Map clones (`new Map(prev`) outside `src/utils/useCoalescedMap.ts`
#      — cloning a Map inside a relay-subscription / event callback fires an
#      O(N) copy + React commit PER EVENT; a burst of 50 events pins the JS
#      thread. The sanctioned pattern is `useCoalescedMap` (which is exempt —
#      its internal clone runs once per ≤150 ms flush, not per event).
#
#   2. `Image` imported from 'react-native' — hot lists must use `expo-image`
#      (`cachePolicy="memory-disk"`); bare RN Image re-decodes on every mount.
#
# Grandfather-aware, mirroring check-file-size.sh: existing occurrences are
# baselined per file and MUST NOT GROW. Shrink counts over time; delete the
# entry at zero; never raise a number. New files with either pattern fail.
set -euo pipefail

# ---------------------------------------------------------------------------
# Check 1: per-event Map clones
declare -A MAP_CLONE_BASELINE=(
  ["src/contexts/LiveLocationContext.tsx"]=1
  ["src/screens/HuntScreen.tsx"]=1
  ["src/screens/MyPigletsScreen.tsx"]=2
)

# Check 2: react-native Image imports (multi-line aware — full sweep 2026-07-11)
declare -A RN_IMAGE_BASELINE=(
  ["src/components/AddWalletWizard.tsx"]=1
  ["src/components/BootSplash.tsx"]=1
  ["src/components/DecryptedImage.tsx"]=1
  ["src/components/HuntRecentlyAddedSection.tsx"]=1
  ["src/components/TransferSheet.tsx"]=1
  ["src/components/WalletCard.tsx"]=1
  ["src/screens/account/AboutScreen.tsx"]=1
  ["src/screens/account/AccountScreenLayout.tsx"]=1
  ["src/screens/account/ProfileScreen.tsx"]=1
  ["src/screens/CourseDetailScreen.tsx"]=1
  ["src/screens/EventDetailScreen.tsx"]=1
  ["src/screens/EventsScreen.tsx"]=1
  ["src/screens/ExploreHomeScreen.tsx"]=1
  ["src/screens/GroupsScreen.tsx"]=1
  ["src/screens/HomeScreen.tsx"]=1
  ["src/screens/HuntCreateScreen.tsx"]=1
  ["src/screens/HuntPiggyDetailScreen.tsx"]=1
  ["src/screens/HuntScreen.tsx"]=1
  ["src/screens/LessonsScreen.tsx"]=1
  ["src/screens/MissionDetailScreen.tsx"]=1
  ["src/screens/MyPigletsScreen.tsx"]=1
  ["src/screens/UnsupportedEntityScreen.tsx"]=1
)

emit_error() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error file=$1::$2"; else echo "ERROR: $1 — $2"; fi
}

fail=0

check_pattern() {
  # $1 = check name, $2 = grep output "file:count" lines, $3 = baseline array name, $4 = fix hint
  local name="$1" hint="$4"
  local -n baseline="$3"
  while IFS=: read -r f count; do
    [ -n "$f" ] || continue
    local base="${baseline[$f]:-0}"
    if [ "$count" -gt "$base" ]; then
      emit_error "$f" "$name: $count occurrence(s), baseline allows $base. $hint"
      fail=1
    fi
  done <<< "$2"
}

# Count occurrences per tracked source file (tests excluded — test fixtures may
# legitimately build Maps).
# Exempt files implement the sanctioned COALESCED-flush pattern: their clones
# run once per <=150 ms flush (or per batch), not per incoming event — the
# same criterion that exempts useCoalescedMap itself. A file only belongs
# here if its clones are provably flush-scoped; per-event clones never do.
# Comment lines (`//`, `/*`, ` *`) are skipped so prose that names the
# anti-pattern can't use up a file's allowance.
map_clones=$(git ls-files 'src/**/*.ts' 'src/**/*.tsx' \
  | grep -v '\.test\.' \
  | grep -v '^src/utils/useCoalescedMap\.ts$' \
  | grep -v '^src/hooks/useFoundLogIngest\.ts$' \
  | xargs perl -ne 'next if m{^\s*(//|/?\*)}; $c{$ARGV}++ if /new Map\(prev/; END { print "$_:$c{$_}\n" for sort keys %c }' \
    2>/dev/null || true)
check_pattern "per-event Map clone" "$map_clones" MAP_CLONE_BASELINE \
  "Batch relay/event ingest with src/utils/useCoalescedMap.ts instead of cloning per event."

# Multi-line aware (Prettier wraps long RN import lists): slurp each file
# (-0777) and count import statements whose brace list contains a bare
# `Image` token and whose module specifier is 'react-native'.
rn_images=$(git ls-files 'src/**/*.tsx' \
  | grep -v '\.test\.' \
  | xargs perl -0777 -ne "my \$c = () = /import[^;]*?\{[^}]*\bImage\b[^}]*\}[^;]*?from\s*'react-native'/gs; print \"\$ARGV:\$c\n\"" 2>/dev/null \
  | grep -v ':0$' || true)
check_pattern "react-native Image import" "$rn_images" RN_IMAGE_BASELINE \
  "Use expo-image with cachePolicy=\"memory-disk\" (see docs/PERFORMANCE.adoc)."

if [ "$fail" -eq 0 ]; then
  echo "perf anti-pattern gate: OK"
fi
exit "$fail"
