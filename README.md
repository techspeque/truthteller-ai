# TruthTeller AI

[![CI](https://github.com/techspeque/truthteller-ai/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/techspeque/truthteller-ai/actions/workflows/ci.yml) [![Release](https://img.shields.io/github/v/release/techspeque/truthteller-ai?display_name=release)](https://github.com/techspeque/truthteller-ai/releases) [![Rust](https://img.shields.io/badge/Rust-1.93.0-DEA584?logo=rust)](https://www.rust-lang.org/) [![Next.js](https://img.shields.io/badge/Next.js-15.2.0-000000?logo=next.js)](https://nextjs.org/) [![Frontend Coverage](https://img.shields.io/badge/Frontend%20Coverage-86.8%25-brightgreen)](#coverage) [![Backend Coverage](https://img.shields.io/badge/Backend%20Coverage-61.75%25-yellow)](#coverage)

TruthTeller AI is a local app that runs a multi-model deliberation workflow through OpenRouter.

Instead of asking one model, you ask a council of models:

1. Stage 1: each model answers independently.
2. Stage 2: models evaluate and rank anonymized Stage 1 responses.
3. Stage 3: a chairman model synthesizes a final answer.

The app supports multi-turn conversations, multi-file uploads, streaming updates, and advanced post-run analysis of council outputs. It runs as a web app (Rust backend + browser) or as a native desktop app (Tauri).

## Features

- 3-stage council orchestration (Stage 1/2/3)
- Multi-turn conversations
- Streaming responses (SSE in web mode, Tauri events in native mode)
- File uploads shared across all council models (`txt`, `md`, `markdown`, `pdf`, `docx`, `pptx`)
- Local file ingestion and text extraction
- Conversation sidebar with create/delete/search
- Full Settings UI (General, Models, Credentials, Advanced)
- Credential management UI for OpenRouter key (set/test/clear with masked status)
- Dark mode toggle (persisted)
- Export conversation to Markdown
- Advanced insights: consensus matrix, influence graph, traceability, side-by-side diff, uncertainty panel, cost/latency breakdown, interactive rerun controls

##  Roadmap

- Add LiteLLM support
- Add release asset auto-update support
- Enable overrides for local data stores

## Architecture

```bash
crates/core/       Shared Rust domain: types, config, storage, council, openrouter, attachments
crates/server/     Web adapter: axum HTTP routes + SSE streaming
backend/           Native adapter: Tauri commands + event streaming
frontend/          Next.js React frontend with dual transport abstraction
```

Both adapters link the same `t2ai-core` crate. The frontend auto-detects the runtime and uses HTTP fetch (web) or Tauri IPC (native).

### Storage

- Conversations: `{data_dir}/conversations/{id}.json`
- Uploaded files: `{data_dir}/uploads/{conversation_id}/...`
- Runtime model config: `{data_dir}/config.json`
- Stored secrets (current implementation for web + native): `{data_dir}/secrets.json`

In web mode `data_dir` defaults to `./data`. In native mode it uses the platform-specific application data directory.

## Requirements

- Rust (stable toolchain)
- Node.js + npm
- OpenRouter API key (via environment variable or Settings UI)

For native mode only:

- Xcode Command Line Tools (macOS)

## Setup

### 1. Install dependencies

```bash
# Rust workspace
cargo build

# Frontend
cd frontend
npm install
cd ..
```

### 2. Configure API key (choose one)

Option A (recommended): set in the app:

- Open Settings
- Go to `Credentials`
- Enter your key and click `Save Key`

Option B: create `.env` in the project root:

```
OPENROUTER_API_KEY=sk-or-v1-...
```

Optional (useful for integration testing with a mock server):

```
OPENROUTER_BASE_URL=http://127.0.0.1:12345
```

If `OPENROUTER_BASE_URL` is unset, the app defaults to `https://openrouter.ai`.

### 3. Configure runtime defaults (optional)

Runtime settings are managed through the Settings UI and persisted to `data/config.json`. Defaults are defined in `crates/core/src/types.rs`.

## Settings and Config

`GET /api/config` now returns:

- all non-secret config fields
- `credentials` status object:
  - `openrouter_configured`
  - `source` (`env`, `stored`, or `missing`)
  - `masked_hint` (when available)

Config fields managed in Settings:

- `council_models`
- `chairman_model`
- `request_timeout_seconds`
- `max_parallel_requests`
- `retry_attempts`
- `retry_backoff_ms`
- `stage2_enabled`
- `stage3_model_override`
- `theme`
- `default_export_format`
- `insights_expanded_default`

Key precedence for runtime requests:

1. `OPENROUTER_API_KEY` environment variable
2. stored key from `secrets.json`
3. missing key error

Runtime impact:

- `request_timeout_seconds`, `retry_attempts`, `retry_backoff_ms`, and `max_parallel_requests` are applied to model requests.
- `stage2_enabled` controls whether Stage 2 runs.
- `stage3_model_override` overrides the chairman model when set.

## Run

### Web mode

Terminal 1 (backend):

```bash
cargo run -p t2ai-server
```

Terminal 2 (frontend):

```bash
npm run dev --prefix frontend
```

Open [http://localhost:3000](http://localhost:3000). Backend runs on port 8001.

### Native mode

```bash
cargo tauri dev
```

This starts the Next.js dev server and opens the Tauri window automatically.

### Build native app

```bash
cargo tauri build
```

Produces platform-appropriate native bundles in `target/release/bundle/`.

- macOS: `.app` bundle and `.dmg` installer
- Linux: `.deb` package and `.AppImage` bundle
- Windows: `.msi` installer and NSIS `-setup.exe` bundle

### Build release with prereq auto-install

```bash
./scripts/release.sh --platform macos
./scripts/release.sh --platform linux
./scripts/release.sh --platform windows
```

This script:

- verifies/installs prerequisites (`scripts/prereqs.sh`)
- runs optional checks/tests
- builds Tauri release artifacts for the current platform

Useful variants:

```bash
# faster build (skip checks/tests)
./scripts/release.sh --platform macos --skip-checks --skip-tests
./scripts/release.sh --platform linux --skip-checks --skip-tests

# cross-target build
./scripts/release.sh --platform macos --target aarch64-apple-darwin
```

For Ubuntu release builds, install the Tauri Linux system packages first:

```bash
sudo apt update
sudo apt install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libxdo-dev \
  libssl-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev \
  patchelf
```

## Upload Support and Limits

Supported file types: `.txt`, `.md`, `.markdown`, `.pdf`, `.docx`, `.pptx`

Limits (defined in `crates/core/src/attachments.rs`):

| Limit | Value |
|-------|-------|
| Max files per message | 10 |
| Max file size | 15 MB |
| Max combined upload size | 40 MB |
| Max extracted chars per file | 30,000 |
| Max total context chars (Stage 1) | 80,000 |

## API Overview (Web Mode)

Base URL: `http://localhost:8001`

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Health check |
| GET | `/api/conversations` | List conversations |
| POST | `/api/conversations` | Create conversation |
| GET | `/api/conversations/{id}` | Get conversation |
| DELETE | `/api/conversations/{id}` | Delete conversation |
| POST | `/api/conversations/{id}/message` | Send message (JSON) |
| POST | `/api/conversations/{id}/message/upload` | Send message (multipart with files) |
| POST | `/api/conversations/{id}/message/stream` | Send message with SSE streaming |
| POST | `/api/conversations/{id}/message/stream/json` | Send JSON message with SSE streaming |
| POST | `/api/conversations/{id}/retry` | Retry failed models |
| POST | `/api/conversations/{id}/rerun` | Rerun Stage 2+3 or Stage 3 |
| GET | `/api/config` | Get config |
| GET | `/api/storage/info` | Get runtime storage paths (data, conversations, uploads, logs, config, secrets) |
| PUT | `/api/config` | Update config |
| POST | `/api/config/credentials/openrouter` | Set/update stored OpenRouter API key |
| DELETE | `/api/config/credentials/openrouter` | Clear stored OpenRouter API key |
| POST | `/api/config/credentials/openrouter/test` | Validate OpenRouter API key |
| GET | `/api/models` | Fetch OpenRouter models |

## Streaming Events

Both web (SSE) and native (Tauri events) emit the same event types:

`upload_processing_start`, `upload_processing_complete`, `stage1_start`, `stage1_complete`, `stage2_start`, `stage2_complete`, `stage3_start`, `stage3_complete`, `title_complete`, `complete`, `error`

## Coverage

Use one command to compute frontend + backend coverage and print a ready-to-paste badge line:

```bash
./scripts/coverage.sh
```

Current line coverage snapshot used by the badge:

- Frontend: `86.8%` (`947/1091`)
- Backend (`t2ai-core`): `61.75%` (`1230/1992`)
- Combined: `70.6%` (`2177/3083`)

## Versioning

This repo uses a single app version across Rust crates, Tauri, and frontend package metadata.

Latest release notes:

- [v0.3.0](./docs/releases/v0.3.0.md)

- Source of truth: `VERSION`
- Check consistency:

  ```bash
  ./scripts/version.sh check
  ```

- Bump all package versions in one command:

  ```bash
  ./scripts/version.sh set 0.2.1
  ```

`./scripts/ci.sh` and `./scripts/release.sh` both run version consistency checks automatically.

## CI/CD

GitHub Actions workflows are included in `.github/workflows/`:

- `ci.yml` (push to `main` and pull requests)
  - Reuses `./scripts/ci.sh`
  - Runs prerequisites, version check, format/lint/tests/build
- `release.yml` (tag push `vX.Y.Z`)
  - Reuses `./scripts/release.sh`
  - Verifies tag version matches `VERSION`
  - Verifies `docs/releases/vX.Y.Z.md` exists for the tag being published
  - Renders the GitHub release body from `.github/release-body.md`
  - Builds macOS, Ubuntu, and Windows Tauri artifacts and publishes a GitHub Release on tag runs

Release flow:

1. Run the pre-flight verification suite: `./scripts/ci.sh --skip-prereqs`
2. Bump versions: `./scripts/version.sh set X.Y.Z`
3. Re-check version sync: `./scripts/version.sh check`
4. Write release notes at `docs/releases/vX.Y.Z.md`
5. Update release documentation links in `README.md` and `docs/README.md`
6. Commit and push
7. Tag and push: `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin main --tags`
8. `release.yml` verifies the tag/doc contract, builds artifacts, renders the release body, and publishes the release

Structured logging is enabled via `tracing`.

- Set `RUST_LOG=debug` for verbose output.
- Web server mode logs to process stdout/stderr.
- Native Tauri mode logs to both stdout/stderr and daily-rotated files in:
  `~/Library/Application Support/dev.t2ai.app/logs/t2ai.log.YYYY-MM-DD`

## Attribution

TruthTeller AI was originally forked from [karpathy/llm-council](https://github.com/karpathy/llm-council) and has since been significantly modified and rebranded.

Portions of this codebase are derived from the upstream project and remain subject to the upstream project's license and attribution requirements.

## License

This repository is distributed under the proprietary [TruthTeller AI License](LICENSE) (all rights reserved), which does not permit rebranding or redistribution without prior written permission.

Third-party and upstream components may have separate license terms that continue to apply to those components.
