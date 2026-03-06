#!/usr/bin/env bash
# Version management helpers for TruthTeller AI.
# Uses VERSION as the source of truth and keeps package manifests aligned.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

VERSION_FILE="${ROOT_DIR}/VERSION"
CORE_TOML="${ROOT_DIR}/crates/core/Cargo.toml"
SERVER_TOML="${ROOT_DIR}/crates/server/Cargo.toml"
TAURI_TOML="${ROOT_DIR}/backend/Cargo.toml"
TAURI_CONF="${ROOT_DIR}/backend/tauri.conf.json"
FRONTEND_PKG="${ROOT_DIR}/frontend/package.json"

is_valid_semver() {
  local v="$1"
  [[ "${v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]
}

require_version_file() {
  if [[ ! -f "${VERSION_FILE}" ]]; then
    echo "Error: VERSION file not found at ${VERSION_FILE}" >&2
    exit 1
  fi
}

read_version_file() {
  require_version_file
  local value
  value="$(tr -d '[:space:]' < "${VERSION_FILE}")"
  if [[ -z "${value}" ]]; then
    echo "Error: VERSION file is empty." >&2
    exit 1
  fi
  if ! is_valid_semver "${value}"; then
    echo "Error: VERSION '${value}' is not a valid semantic version." >&2
    exit 1
  fi
  echo "${value}"
}

toml_version() {
  local file="$1"
  awk -F'"' '/^version = "/ {print $2; exit}' "${file}"
}

json_field() {
  local file="$1"
  local field="$2"
  node -e 'const fs=require("fs");const o=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));console.log(o[process.argv[2]] || "");' "${file}" "${field}"
}

check_equal() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [[ "${expected}" != "${actual}" ]]; then
    echo "Version mismatch: ${label} is '${actual}', expected '${expected}'." >&2
    return 1
  fi
  return 0
}

write_json_field() {
  local file="$1"
  local field="$2"
  local value="$3"
  node -e 'const fs=require("fs");const p=process.argv[1];const k=process.argv[2];const v=process.argv[3];const o=JSON.parse(fs.readFileSync(p,"utf8"));o[k]=v;fs.writeFileSync(p, JSON.stringify(o, null, 2) + "\n");' "${file}" "${field}" "${value}"
}

set_all_versions() {
  local new_version="$1"

  if ! is_valid_semver "${new_version}"; then
    echo "Error: '${new_version}' is not a valid semantic version." >&2
    exit 1
  fi

  printf '%s\n' "${new_version}" > "${VERSION_FILE}"

  perl -0pi -e "s/^version = \".*?\"$/version = \"${new_version}\"/m" "${CORE_TOML}"
  perl -0pi -e "s/^version = \".*?\"$/version = \"${new_version}\"/m" "${SERVER_TOML}"
  perl -0pi -e "s/^version = \".*?\"$/version = \"${new_version}\"/m" "${TAURI_TOML}"
  write_json_field "${TAURI_CONF}" "version" "${new_version}"
  write_json_field "${FRONTEND_PKG}" "version" "${new_version}"

  echo "Set all versions to ${new_version}"
}

check_versions() {
  local expect_tag="${1:-}"
  local expected
  local failures=0
  expected="$(read_version_file)"

  check_equal "crates/core/Cargo.toml" "${expected}" "$(toml_version "${CORE_TOML}")" || failures=1
  check_equal "crates/server/Cargo.toml" "${expected}" "$(toml_version "${SERVER_TOML}")" || failures=1
  check_equal "backend/Cargo.toml" "${expected}" "$(toml_version "${TAURI_TOML}")" || failures=1
  check_equal "backend/tauri.conf.json" "${expected}" "$(json_field "${TAURI_CONF}" "version")" || failures=1
  check_equal "frontend/package.json" "${expected}" "$(json_field "${FRONTEND_PKG}" "version")" || failures=1

  if [[ -n "${expect_tag}" ]]; then
    local normalized_tag="${expect_tag#refs/tags/}"
    normalized_tag="${normalized_tag#v}"
    check_equal "git tag" "${expected}" "${normalized_tag}" || failures=1
  fi

  if [[ "${failures}" -ne 0 ]]; then
    echo "Version check failed." >&2
    exit 1
  fi

  echo "Version check passed (${expected})"
}

print_usage() {
  cat <<'USAGE'
Usage:
  ./scripts/version.sh print
  ./scripts/version.sh check [--expect-tag <tag>]
  ./scripts/version.sh set <version>

Examples:
  ./scripts/version.sh check
  ./scripts/version.sh check --expect-tag v0.2.0
  ./scripts/version.sh set 0.2.0
USAGE
}

cmd="${1:-}"
case "${cmd}" in
  print)
    read_version_file
    ;;
  check)
    shift
    expect_tag=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --expect-tag)
          expect_tag="${2:-}"
          if [[ -z "${expect_tag}" ]]; then
            echo "Error: --expect-tag requires a value." >&2
            exit 1
          fi
          shift 2
          ;;
        *)
          echo "Error: unknown option: $1" >&2
          print_usage
          exit 1
          ;;
      esac
    done
    check_versions "${expect_tag}"
    ;;
  set)
    shift
    new_version="${1:-}"
    if [[ -z "${new_version}" ]]; then
      echo "Error: set requires a version value." >&2
      print_usage
      exit 1
    fi
    set_all_versions "${new_version}"
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
