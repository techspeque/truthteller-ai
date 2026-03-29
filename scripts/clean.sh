#!/usr/bin/env bash
# Remove project-local caches and generated build artifacts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

print_usage() {
  cat <<'USAGE'
Clean local caches and generated artifacts for Granite.

Usage:
  ./scripts/clean.sh

Removes:
  - .corepack
  - .pnpm-store
  - frontend/.next
  - frontend/out
  - frontend/coverage
  - target
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      echo "Error: unknown option: $1" >&2
      print_usage
      exit 1
      ;;
  esac
done

cd "${ROOT_DIR}"

CLEAN_PATHS=(
  ".corepack"
  ".pnpm-store"
  "frontend/.next"
  "frontend/out"
  "frontend/coverage"
  "target"
)

removed_any=0

for rel_path in "${CLEAN_PATHS[@]}"; do
  abs_path="${ROOT_DIR}/${rel_path}"
  if [[ -e "${abs_path}" ]]; then
    echo "Removing ${rel_path}"
    rm -rf "${abs_path}"
    removed_any=1
  else
    echo "Skipping ${rel_path} (not present)"
  fi
done

if [[ "${removed_any}" -eq 0 ]]; then
  echo ""
  echo "Nothing to clean."
else
  echo ""
  echo "Local caches cleaned."
fi
