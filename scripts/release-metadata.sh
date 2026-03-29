#!/usr/bin/env bash
# Validate release-note inputs and render the templated GitHub release body.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

RELEASE_TEMPLATE="${ROOT_DIR}/.github/release-body.md"
GETTING_STARTED_DOC="docs/getting-started.md"

is_valid_semver() {
  local v="$1"
  [[ "${v}" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]]
}

normalize_tag() {
  local input="${1#refs/tags/}"
  input="${input#v}"

  if ! is_valid_semver "${input}"; then
    echo "Error: '${1}' is not a valid release tag or semantic version." >&2
    exit 1
  fi

  echo "v${input}"
}

release_doc_relpath() {
  local tag
  tag="$(normalize_tag "${1}")"
  echo "docs/releases/${tag}.md"
}

require_repo_file() {
  local relpath="$1"

  if [[ ! -f "${ROOT_DIR}/${relpath}" ]]; then
    echo "Error: required file not found: ${relpath}" >&2
    exit 1
  fi
}

check_release_files() {
  local tag="$1"
  local release_doc

  release_doc="$(release_doc_relpath "${tag}")"

  require_repo_file "${release_doc}"
  require_repo_file "${GETTING_STARTED_DOC}"
  require_repo_file ".github/release-body.md"

  echo "Release metadata check passed for ${tag}"
}

render_release_body() {
  local tag="$1"
  local repo="$2"
  local output_path="$3"
  local normalized_tag
  local release_doc
  local release_doc_url
  local getting_started_url

  normalized_tag="$(normalize_tag "${tag}")"
  release_doc="$(release_doc_relpath "${normalized_tag}")"
  release_doc_url="https://github.com/${repo}/blob/${normalized_tag}/${release_doc}"
  getting_started_url="https://github.com/${repo}/blob/${normalized_tag}/${GETTING_STARTED_DOC}"

  check_release_files "${normalized_tag}" >/dev/null

  node -e '
const fs = require("fs");
const [templatePath, outputPath, releaseDocPath, releaseDocUrl, gettingStartedUrl] = process.argv.slice(1);
const rendered = fs
  .readFileSync(templatePath, "utf8")
  .replaceAll("__RELEASE_DOC_PATH__", releaseDocPath)
  .replaceAll("__RELEASE_DOC_URL__", releaseDocUrl)
  .replaceAll("__GETTING_STARTED_URL__", gettingStartedUrl);
fs.writeFileSync(outputPath, rendered);
' "${RELEASE_TEMPLATE}" "${output_path}" "${release_doc}" "${release_doc_url}" "${getting_started_url}"

  echo "Rendered release body to ${output_path}"
}

print_usage() {
  cat <<'USAGE'
Usage:
  ./scripts/release-metadata.sh check --tag <vX.Y.Z>
  ./scripts/release-metadata.sh render-body --tag <vX.Y.Z> --repo <owner/repo> --output <file>
USAGE
}

cmd="${1:-}"
case "${cmd}" in
  check)
    shift
    tag=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --tag)
          tag="${2:-}"
          shift 2
          ;;
        *)
          echo "Error: unknown option: $1" >&2
          print_usage
          exit 1
          ;;
      esac
    done

    if [[ -z "${tag}" ]]; then
      echo "Error: check requires --tag <vX.Y.Z>." >&2
      print_usage
      exit 1
    fi

    check_release_files "${tag}"
    ;;
  render-body)
    shift
    tag=""
    repo=""
    output=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --tag)
          tag="${2:-}"
          shift 2
          ;;
        --repo)
          repo="${2:-}"
          shift 2
          ;;
        --output)
          output="${2:-}"
          shift 2
          ;;
        *)
          echo "Error: unknown option: $1" >&2
          print_usage
          exit 1
          ;;
      esac
    done

    if [[ -z "${tag}" || -z "${repo}" || -z "${output}" ]]; then
      echo "Error: render-body requires --tag, --repo, and --output." >&2
      print_usage
      exit 1
    fi

    render_release_body "${tag}" "${repo}" "${output}"
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
