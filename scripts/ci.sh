#!/usr/bin/env bash
# Non-interactive CI script for TruthTeller AI.
# Runs shared prerequisites, version checks, formatting checks, lints, tests, and frontend build.
# Exit on first failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RUN_PREREQS=1
PLATFORM=""

print_usage() {
  cat <<'USAGE'
Run CI checks for TruthTeller AI.

Options:
  --platform <macos|linux>  Explicit platform for prerequisites
  --skip-prereqs            Skip prerequisites/install step
  -h, --help                Show this help message
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      PLATFORM="${2:-}"
      if [[ -z "${PLATFORM}" ]]; then
        echo "Error: --platform requires a value." >&2
        exit 1
      fi
      shift 2
      ;;
    --skip-prereqs)
      RUN_PREREQS=0
      shift
      ;;
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

if [[ "${RUN_PREREQS}" -eq 1 ]]; then
  echo "=== Prerequisites ==="
  PREREQ_ARGS=(--npm-ci)
  if [[ -n "${PLATFORM}" ]]; then
    PREREQ_ARGS+=(--platform "${PLATFORM}")
  fi
  "${SCRIPT_DIR}/prereqs.sh" "${PREREQ_ARGS[@]}"
fi

echo "=== Rust: format check ==="
cargo fmt --all --check

echo "=== Version consistency ==="
"${SCRIPT_DIR}/version.sh" check

echo "=== Rust: clippy (warnings = errors) ==="
cargo clippy --workspace -- -D warnings

echo "=== Rust: tests ==="
cargo test -p t2ai-core

echo "=== Rust: workspace build ==="
cargo build --workspace

echo "=== Frontend: lint ==="
(cd frontend && npm run lint)

echo "=== Frontend: build ==="
(cd frontend && npm run build)

echo ""
echo "All CI checks passed."
