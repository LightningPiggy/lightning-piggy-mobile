#!/usr/bin/env bash
# Enforce the "no source file over 1,000 lines" rule (CLAUDE.md → File size and
# modularity). Scans tracked JS/TS source (AsciiDoc/Markdown/JSON etc. are not
# code and are excluded by the extension filter).
#
# Grandfather-aware: the files already over the cap when the rule landed are
# baselined below. They are allowed to exist BUT MUST NOT GROW — extract, don't
# append (see issue #703). Any *new* file over the cap, or any baselined file
# that grows past its recorded size, fails the build.
set -euo pipefail

LIMIT=1000

# Baseline of pre-existing over-cap files (path → max allowed lines = the count
# when the rule landed, 2026-05-26). Shrink these over time and lower the number
# here; never raise it. Delete the entry once a file drops under the cap.
declare -A BASELINE=(
  ["src/contexts/NostrContext.tsx"]=1476
  ["src/screens/HuntCreateScreen.tsx"]=2386
  ["src/contexts/WalletContext.tsx"]=1579
  ["src/screens/HuntPiggyDetailScreen.tsx"]=1256
  ["src/screens/MapScreen.tsx"]=1142
  ["src/components/TransferSheet.tsx"]=1282
  ["src/screens/ExploreHomeScreen.tsx"]=1222
  ["src/services/nfcService.ts"]=1242
  ["src/components/SendSheet.tsx"]=1010
)

# GitHub Actions error annotation when running in CI; plain echo locally.
emit_error() {
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::error file=$1::$2"; else echo "ERROR: $1 — $2"; fi
}

fail=0
while IFS= read -r f; do
  [ -f "$f" ] || continue
  lines=$(wc -l < "$f" | tr -d ' ')
  base="${BASELINE[$f]:-}"
  if [ -n "$base" ]; then
    if [ "$lines" -gt "$base" ]; then
      emit_error "$f" "grew to ${lines} lines (baseline ${base}). Over-cap files must shrink, not grow — extract logic into its own module, don't append. See #703 + CLAUDE.md."
      fail=1
    fi
  elif [ "$lines" -gt "$LIMIT" ]; then
    emit_error "$f" "${lines} lines exceeds the ${LIMIT}-line cap. Split it into logically-cohesive modules (CLAUDE.md → File size and modularity)."
    fail=1
  fi
done < <(git ls-files | grep -E '\.(ts|tsx|js|jsx)$')

if [ "$fail" -eq 0 ]; then
  echo "✓ file-size check passed (no new files over ${LIMIT} lines; baselined files did not grow)"
fi
exit "$fail"
