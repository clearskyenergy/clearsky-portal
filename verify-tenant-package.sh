#!/usr/bin/env bash
# ============================================================================
# verify-tenant-package.sh
#
# Two jobs, run before any tenant .zip goes out:
#   1. FAIL if an admin-only file is present in a tenant build.
#   2. FAIL if a shared platform file drifted from the reference copy.
#
# Usage:
#   tools/verify-tenant-package.sh <reference-dir> <tenant-dir> [tenant-dir...]
#
# Example:
#   tools/verify-tenant-package.sh ./platform ./tenants/iqgen ./tenants/fenecon
#
# Exit 0 = safe to package. Any non-zero = do not ship.
# ============================================================================
set -uo pipefail

# Files that must NEVER appear in a tenant repo. The intake queue reads every
# tenant's records, so shipping it inside a tenant build would hand one
# customer a window into all the others.
ADMIN_ONLY=(
  "intake-admin.html"
)

# Files that must be byte-identical in every tenant repo. omega-intake.js sits
# on both sides of the boundary: the tenant tool and the sales app both read
# the same schema from it, so a change has to land in both places together.
SHARED=(
  "omega-intake.js"
  "intake.html"
  "index.html"
  "marketplace.html"
  "projects.html"
  "editor.html"
  "omega-brand.js"
)

# The only file allowed to differ per tenant.
TENANT_LOCAL="config.js"

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; DIM=$'\033[2m'; OFF=$'\033[0m'
fails=0; warns=0

if [ $# -lt 2 ]; then
  echo "usage: $0 <reference-dir> <tenant-dir> [tenant-dir...]" >&2
  exit 2
fi

REF="${1%/}"; shift
[ -d "$REF" ] || { echo "${RED}reference dir not found: $REF${OFF}" >&2; exit 2; }

sum() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

echo "reference: $REF"
echo

for TENANT in "$@"; do
  TENANT="${TENANT%/}"
  name=$(basename "$TENANT")
  echo "── $name ──────────────────────────────────────────"

  if [ ! -d "$TENANT" ]; then
    echo "  ${RED}✗ not a directory${OFF}"; fails=$((fails+1)); echo; continue
  fi

  # ---- 1. admin-only leakage -------------------------------------------
  for f in "${ADMIN_ONLY[@]}"; do
    found=$(find "$TENANT" -name "$f" -not -path '*/node_modules/*' 2>/dev/null)
    if [ -n "$found" ]; then
      echo "  ${RED}✗ ADMIN FILE IN TENANT BUILD${OFF}"
      echo "$found" | sed 's/^/      /'
      echo "      ${DIM}delete it — this file reads every tenant's queue${OFF}"
      fails=$((fails+1))
    else
      echo "  ${GRN}✓${OFF} no admin-only files"
    fi
  done

  # ---- 2. shared file integrity ----------------------------------------
  for f in "${SHARED[@]}"; do
    r="$REF/$f"; t="$TENANT/$f"
    if [ ! -f "$r" ]; then
      echo "  ${DIM}· $f not in reference, skipped${OFF}"; continue
    fi
    if [ ! -f "$t" ]; then
      echo "  ${YEL}! $f missing from tenant${OFF}"; warns=$((warns+1)); continue
    fi
    if [ "$(sum "$r")" = "$(sum "$t")" ]; then
      echo "  ${GRN}✓${OFF} $f ${DIM}$(sum "$t" | cut -c1-12)${OFF}"
    else
      echo "  ${RED}✗ $f DRIFTED${OFF}"
      echo "      ref    $(sum "$r" | cut -c1-12)"
      echo "      tenant $(sum "$t" | cut -c1-12)"
      if command -v diff >/dev/null; then
        echo "      ${DIM}$(diff "$r" "$t" | head -4 | sed 's/^/      /')${OFF}"
      fi
      fails=$((fails+1))
    fi
  done

  # ---- 3. config.js present and actually tenant-specific ---------------
  if [ -f "$TENANT/$TENANT_LOCAL" ]; then
    if grep -qE "orgId\s*:" "$TENANT/$TENANT_LOCAL"; then
      org=$(grep -oE "orgId\s*:\s*['\"][^'\"]+" "$TENANT/$TENANT_LOCAL" | head -1 | sed "s/.*['\"]//")
      echo "  ${GRN}✓${OFF} $TENANT_LOCAL present ${DIM}orgId: $org${OFF}"
    else
      echo "  ${RED}✗ $TENANT_LOCAL has no orgId — intake records will not isolate${OFF}"
      fails=$((fails+1))
    fi
    if [ -f "$REF/$TENANT_LOCAL" ] && [ "$(sum "$REF/$TENANT_LOCAL")" = "$(sum "$TENANT/$TENANT_LOCAL")" ]; then
      echo "  ${RED}✗ $TENANT_LOCAL is identical to the reference — not customized${OFF}"
      fails=$((fails+1))
    fi
  else
    echo "  ${RED}✗ $TENANT_LOCAL missing${OFF}"; fails=$((fails+1))
  fi

  # ---- 4. no admin origin hardcoded into shared files ------------------
  leak=$(grep -rln "clearsky-usa\.com" "$TENANT" \
        --include="*.html" --include="*.js" 2>/dev/null \
        | grep -v "$TENANT_LOCAL" || true)
  if [ -n "$leak" ]; then
    echo "  ${YEL}! admin origin referenced outside $TENANT_LOCAL${OFF}"
    echo "$leak" | sed 's/^/      /'
    echo "      ${DIM}fine if it is only a support email; move endpoints to config.js${OFF}"
    warns=$((warns+1))
  fi

  echo
done

echo "══════════════════════════════════════════════════"
if [ "$fails" -gt 0 ]; then
  echo "${RED}$fails failure(s) — do not package${OFF}"
  exit 1
fi
if [ "$warns" -gt 0 ]; then
  echo "${YEL}clean, with $warns warning(s)${OFF}"
else
  echo "${GRN}clean — safe to package${OFF}"
fi
exit 0
