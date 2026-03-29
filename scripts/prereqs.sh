#!/usr/bin/env bash
# Install/verify prerequisites shared by release and CI scripts.
#
# Usage:
#   ./scripts/prereqs.sh
#   ./scripts/prereqs.sh --platform macos --target aarch64-apple-darwin --ensure-tauri-cli
#   ./scripts/prereqs.sh --platform windows --ensure-tauri-cli

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

PLATFORM=""
TARGET=""
FORCE_FRONTEND_INSTALL=0
ENSURE_TAURI_CLI=0
USE_NPM_CI=0

detect_platform() {
  case "$(uname -s)" in
    Darwin) echo "macos" ;;
    Linux) echo "linux" ;;
    MINGW*|MSYS*|CYGWIN*) echo "windows" ;;
    *) echo "unknown" ;;
  esac
}

require_command() {
  local cmd="$1"
  local install_hint="$2"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Error: '${cmd}' is not installed or not in PATH." >&2
    if [[ -n "${install_hint}" ]]; then
      echo "${install_hint}" >&2
    fi
    exit 1
  fi
}

print_usage() {
  cat <<'USAGE'
Install/verify prerequisites for TruthTeller AI scripts.

Options:
  --platform <macos|linux|windows>  Explicit platform (default: detect from host)
  --target <triple>            Add a Rust target (for cross-arch builds)
  --ensure-tauri-cli           Install Tauri CLI if missing
  --force-frontend-install     Install frontend deps even if node_modules exists
  --npm-ci                     Use npm ci for frontend deps
  -h, --help                   Show this help message
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
    --target)
      TARGET="${2:-}"
      if [[ -z "${TARGET}" ]]; then
        echo "Error: --target requires a value." >&2
        exit 1
      fi
      shift 2
      ;;
    --ensure-tauri-cli)
      ENSURE_TAURI_CLI=1
      shift
      ;;
    --force-frontend-install)
      FORCE_FRONTEND_INSTALL=1
      shift
      ;;
    --npm-ci)
      USE_NPM_CI=1
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

HOST_PLATFORM="$(detect_platform)"
if [[ "${HOST_PLATFORM}" == "unknown" ]]; then
  echo "Error: unsupported host platform: $(uname -s)" >&2
  exit 1
fi

if [[ -z "${PLATFORM}" ]]; then
  PLATFORM="${HOST_PLATFORM}"
fi

case "${PLATFORM}" in
  macos|linux|windows)
    ;;
  *)
    echo "Error: unsupported platform '${PLATFORM}'. Use 'macos', 'linux', or 'windows'." >&2
    exit 1
    ;;
esac

if [[ "${PLATFORM}" != "${HOST_PLATFORM}" ]]; then
  echo "Error: requested --platform ${PLATFORM}, but host platform is ${HOST_PLATFORM}." >&2
  echo "Run this script on a matching host platform." >&2
  exit 1
fi

require_command cargo "Install Rust toolchain first: https://rustup.rs/"
require_command rustup "Install Rust toolchain first: https://rustup.rs/"
require_command node "Install Node.js first: https://nodejs.org/"
require_command npm "Install Node.js/npm first: https://nodejs.org/"

if [[ "${PLATFORM}" == "macos" ]]; then
  if ! xcode-select -p >/dev/null 2>&1; then
    echo "Xcode Command Line Tools not detected." >&2
    echo "Triggering installation prompt..." >&2
    xcode-select --install || true
    echo "Complete Xcode CLT installation, then rerun this script." >&2
    exit 1
  fi
fi

if [[ "${ENSURE_TAURI_CLI}" -eq 1 ]]; then
  if ! cargo tauri --help >/dev/null 2>&1; then
    echo "Installing Tauri CLI (cargo install tauri-cli --locked)..."
    cargo install tauri-cli --locked
  else
    echo "Tauri CLI already installed."
  fi
fi

if [[ -n "${TARGET}" ]]; then
  if rustup target list --installed | grep -qx "${TARGET}"; then
    echo "Rust target already installed: ${TARGET}"
  else
    echo "Adding Rust target: ${TARGET}"
    rustup target add "${TARGET}"
  fi
fi

cd "${ROOT_DIR}"

if [[ "${USE_NPM_CI}" -eq 1 || "${FORCE_FRONTEND_INSTALL}" -eq 1 || ! -d "${ROOT_DIR}/frontend/node_modules" ]]; then
  if [[ "${USE_NPM_CI}" -eq 1 ]]; then
    echo "Installing frontend dependencies with npm ci..."
    npm ci --prefix frontend
  else
    echo "Installing frontend dependencies with npm install..."
    npm install --prefix frontend
  fi
else
  echo "Frontend dependencies already present."
fi

echo "Prerequisites are ready for platform: ${PLATFORM}."
