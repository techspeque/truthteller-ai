#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

FRONTEND_JSON="${REPO_ROOT}/frontend/coverage/coverage-summary.json"
BACKEND_JSON="${REPO_ROOT}/target/coverage/backend-summary.json"

mkdir -p "${REPO_ROOT}/target/coverage"

echo "=== Frontend coverage ==="
(cd "${REPO_ROOT}/frontend" && npm run coverage)

echo "=== Backend coverage ==="
(cd "${REPO_ROOT}" && cargo llvm-cov -p t2ai-core --json --summary-only --output-path "${BACKEND_JSON}")

RUST_VERSION="$(rustc --version | awk '{print $2}')"
NEXT_VERSION="$(node -e "const pkg=require('${REPO_ROOT}/frontend/package.json');console.log((pkg.dependencies.next||'').replace(/^[^0-9]*/, ''))")"

node - <<'NODE' "${FRONTEND_JSON}" "${BACKEND_JSON}" "${RUST_VERSION}" "${NEXT_VERSION}"
const fs = require('node:fs');

const frontendPath = process.argv[2];
const backendPath = process.argv[3];
const rustVersion = process.argv[4];
const nextVersion = process.argv[5];

const frontend = JSON.parse(fs.readFileSync(frontendPath, 'utf8')).total.lines;
const backend = JSON.parse(fs.readFileSync(backendPath, 'utf8')).data[0].totals.lines;

const frontendPct = Number(frontend.pct.toFixed(1));
const backendPct = Number(backend.percent.toFixed(2));

const covered = frontend.covered + backend.covered;
const total = frontend.total + backend.count;
const combinedPct = Number(((covered / total) * 100).toFixed(1));

let color = 'red';
if (combinedPct >= 80) color = 'brightgreen';
else if (combinedPct >= 70) color = 'green';
else if (combinedPct >= 60) color = 'yellow';
else if (combinedPct >= 50) color = 'orange';

let frontendColor = 'red';
if (frontendPct >= 80) frontendColor = 'brightgreen';
else if (frontendPct >= 70) frontendColor = 'green';
else if (frontendPct >= 60) frontendColor = 'yellow';
else if (frontendPct >= 50) frontendColor = 'orange';

let backendColor = 'red';
if (backendPct >= 80) backendColor = 'brightgreen';
else if (backendPct >= 70) backendColor = 'green';
else if (backendPct >= 60) backendColor = 'yellow';
else if (backendPct >= 50) backendColor = 'orange';

console.log('');
console.log('Coverage summary');
console.log(`- Frontend lines: ${frontendPct}% (${frontend.covered}/${frontend.total})`);
console.log(`- Backend lines: ${backendPct}% (${backend.covered}/${backend.count})`);
console.log(`- Combined lines: ${combinedPct}% (${covered}/${total})`);
console.log('');
console.log('README badges');
console.log(`[![Rust](https://img.shields.io/badge/Rust-${rustVersion}-DEA584?logo=rust)](https://www.rust-lang.org/) [![Next.js](https://img.shields.io/badge/Next.js-${nextVersion}-000000?logo=next.js)](https://nextjs.org/) [![Frontend Coverage](https://img.shields.io/badge/Frontend%20Coverage-${frontendPct}%25-${frontendColor})](#coverage) [![Backend Coverage](https://img.shields.io/badge/Backend%20Coverage-${backendPct}%25-${backendColor})](#coverage) [![Combined Coverage](https://img.shields.io/badge/Combined%20Coverage-${combinedPct}%25-${color})](#coverage)`);
NODE
