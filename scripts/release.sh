#!/usr/bin/env bash
# Build a release bundle for TruthTeller AI (Tauri + Next.js frontend).
#
# Usage:
#   ./scripts/release.sh --platform macos
#   ./scripts/release.sh --platform macos --skip-checks --skip-tests
#   ./scripts/release.sh --platform macos --target aarch64-apple-darwin

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

RUN_CHECKS=1
RUN_TESTS=1
CLEAN_BUILD=0
RUN_PREREQS=1
TARGET=""
PLATFORM=""

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    *) echo "unknown" ;;
  esac
}

print_usage() {
  cat <<'USAGE'
Build a release for TruthTeller AI.

Options:
  --platform <macos|linux>  Target platform (default: detect from host)
  --skip-prereqs            Skip automatic prerequisites/install step
  --skip-checks             Skip format/clippy/frontend lint checks
  --skip-tests              Skip Rust workspace tests
  --clean                   Clean build artifacts before building
  --target <triple>         Build for a specific Rust target (e.g. aarch64-apple-darwin)
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
    --skip-checks)
      RUN_CHECKS=0
      shift
      ;;
    --skip-prereqs)
      RUN_PREREQS=0
      shift
      ;;
    --skip-tests)
      RUN_TESTS=0
      shift
      ;;
    --clean)
      CLEAN_BUILD=1
      shift
      ;;
    --target)
      TARGET="${2:-}"
      if [[ -z "${TARGET}" ]]; then
        echo "Error: --target requires a value." >&2
        exit 1
      fi
      shift 2
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

HOST_PLATFORM="$(detect_platform)"
if [[ "${HOST_PLATFORM}" == "unknown" ]]; then
  echo "Error: unsupported host platform: $(uname -s)" >&2
  exit 1
fi

if [[ -z "${PLATFORM}" ]]; then
  PLATFORM="${HOST_PLATFORM}"
fi

case "${PLATFORM}" in
  macos|linux)
    ;;
  *)
    echo "Error: unsupported platform '${PLATFORM}'. Use 'macos' or 'linux'." >&2
    exit 1
    ;;
esac

if [[ "${PLATFORM}" != "${HOST_PLATFORM}" ]]; then
  echo "Error: requested --platform ${PLATFORM}, but host platform is ${HOST_PLATFORM}." >&2
  echo "Run release builds on a matching host platform." >&2
  exit 1
fi

for cmd in bash cargo npm; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Error: '${cmd}' is not installed or not in PATH." >&2
    exit 1
  fi
done

cd "${ROOT_DIR}"

if [[ "${RUN_PREREQS}" -eq 1 ]]; then
  echo "=== Ensuring ${PLATFORM} prerequisites ==="
  PREREQ_ARGS=(--platform "${PLATFORM}" --ensure-tauri-cli)
  if [[ -n "${TARGET}" ]]; then
    PREREQ_ARGS+=(--target "${TARGET}")
  fi
  "${SCRIPT_DIR}/prereqs.sh" "${PREREQ_ARGS[@]}"
fi

if ! cargo tauri --help >/dev/null 2>&1; then
  echo "Error: Tauri CLI is not available via 'cargo tauri' after prerequisite step." >&2
  exit 1
fi

if [[ "${CLEAN_BUILD}" -eq 1 ]]; then
  echo "=== Cleaning previous artifacts ==="
  cargo clean
  rm -rf frontend/.next frontend/out
fi

echo "=== Version consistency ==="
if [[ -n "${GITHUB_REF_NAME:-}" ]]; then
  "${SCRIPT_DIR}/version.sh" check --expect-tag "${GITHUB_REF_NAME}"
else
  "${SCRIPT_DIR}/version.sh" check
fi

if [[ "${RUN_CHECKS}" -eq 1 ]]; then
  echo "=== Rust format check ==="
  cargo fmt --all --check

  echo "=== Rust clippy ==="
  cargo clippy --workspace -- -D warnings

  echo "=== Frontend lint ==="
  npm run lint --prefix frontend
fi

if [[ "${RUN_TESTS}" -eq 1 ]]; then
  echo "=== Rust tests ==="
  cargo test --workspace --locked
fi

echo "=== Building ${PLATFORM} release bundle ==="
if [[ -n "${TARGET}" ]]; then
  cargo tauri build --target "${TARGET}"
  CANDIDATE_BUNDLE_DIRS=(
    "${ROOT_DIR}/target/${TARGET}/release/bundle"
    "${ROOT_DIR}/backend/target/${TARGET}/release/bundle"
  )
else
  cargo tauri build
  CANDIDATE_BUNDLE_DIRS=(
    "${ROOT_DIR}/target/release/bundle"
    "${ROOT_DIR}/backend/target/release/bundle"
  )
fi

FOUND_BUNDLE_DIR=""
for dir in "${CANDIDATE_BUNDLE_DIRS[@]}"; do
  if [[ -d "${dir}" ]]; then
    FOUND_BUNDLE_DIR="${dir}"
    break
  fi
done

echo ""
echo "Release build complete."
if [[ -n "${FOUND_BUNDLE_DIR}" ]]; then
  echo "Artifacts directory: ${FOUND_BUNDLE_DIR}"
else
  echo "Artifacts directory: (not found)"
fi

echo ""
echo "Found artifacts:"
if [[ -n "${FOUND_BUNDLE_DIR}" ]]; then
  if [[ "${PLATFORM}" == "macos" ]]; then
    find "${FOUND_BUNDLE_DIR}" \( -name "*.dmg" -o -name "*.app" -o -name "*.app.tar.gz" \) | sed 's#^#  - #'
  else
    find "${FOUND_BUNDLE_DIR}" \( -name "*.AppImage" -o -name "*.deb" -o -name "*.rpm" -o -name "*.tar.gz" \) | sed 's#^#  - #'
  fi
else
  echo "  - (bundle directory not found)"
  echo "Searched:"
  for dir in "${CANDIDATE_BUNDLE_DIRS[@]}"; do
    echo "  - ${dir}"
  done
fi
