# CLAUDE.md - Technical Notes for TruthTeller AI

Technical details, architectural decisions, and implementation notes for future development sessions.

## Project Overview

TruthTeller AI is a 3-stage deliberation system where multiple LLMs collaboratively answer user questions. The key innovation is anonymized peer review in Stage 2, preventing models from playing favorites.

The project runs in two modes from one codebase:
- **Web mode**: Rust axum backend + Next.js frontend in browser
- **Native mode**: Tauri macOS app wrapping the same frontend + Rust core

## Architecture

### Rust Workspace

```
crates/core/       Shared domain logic (t2ai-core crate)
crates/server/     Web adapter (axum HTTP + SSE)
backend/           Native adapter (Tauri commands + events)
```

### Shared Core (`crates/core/src/`)

**`types.rs`** — All shared types with serde derive, matching the JSON schema used for storage.

**`config.rs`** — `load_config(data_dir)` / `save_config(data_dir, config)`. Reads `{data_dir}/config.json`, falls back to defaults (GPT-5.1, Gemini 3 Pro, Claude Sonnet 4.5, Grok 4; chairman = Gemini 3 Pro).

**`storage.rs`** — Full conversation CRUD. JSON files in `{data_dir}/conversations/{uuid}.json`. Functions: `create_conversation`, `get_conversation`, `list_conversations`, `save_conversation`, `delete_conversation`, `update_conversation_title`, `add_user_message`, `add_assistant_message`, `save_attachment_file`.

**`openrouter.rs`** — Async HTTP client for OpenRouter API. `query_model()` and `query_models_parallel()` using reqwest + futures. Graceful degradation (returns None on failure). Latency tracking and usage extraction.

**`council.rs`** — 3-stage orchestration:
- `stage1_collect_responses()`: Parallel queries to council models
- `stage2_collect_rankings()`: Anonymizes responses, builds ranking prompt, parses results
- `stage3_synthesize_final()`: Chairman synthesis with full context
- `run_full_council()`: End-to-end orchestration
- `generate_conversation_title()`: Uses gemini-2.5-flash
- `parse_ranking_from_text()`: Regex-based ranking parser
- `calculate_aggregate_rankings()`: Average rank position computation

**`attachments.rs`** — File upload processing:
- Validation (limits, extensions, empty files)
- Text extraction: txt/md (UTF-8), PDF (pdf-extract), DOCX/PPTX (zip + quick-xml)
- Per-file and total context truncation
- Preview/trace excerpt generation
- `build_stage1_query()`: Context injection prompt

**`contract.rs`** — Adapter parity contract. Defines `STREAMING_EVENT_ORDER`, `CouncilEvent` envelope, and verification functions for event ordering and payload completeness.

**`migrate.rs`** — Data migration utility for copying between data directories.

**`errors.rs`** — `CouncilError` enum (NotFound, Validation, Api, Extraction, Storage, Request, Json, Io).

### Web Adapter (`crates/server/src/`)

**`state.rs`** — `AppState` wrapping `Arc<Inner>` with data_dir, api_key, http_client.

**`routes.rs`** — All HTTP route handlers. Conversations CRUD, config, models proxy, send message (JSON and multipart), retry, rerun. `ApiError` type for consistent error responses.

**`sse.rs`** — SSE streaming endpoints. Emits events progressively as each council stage completes. Title generation runs concurrently via `tokio::spawn`.

**`main.rs`** — Route wiring, CORS, `.env` loading, `--migrate` CLI flag. Port 8001.

### Tauri Adapter (`backend/src/`)

**`lib.rs`** — 12 Tauri commands matching the web API. Uses `app.emit("t2ai-event", payload)` for streaming. State managed via `Arc<TauriState>`. Data directory = macOS Application Support.

### Frontend (`frontend/src/`)

**`lib/transport.js`** — Dual transport abstraction. Auto-detects Tauri vs web. HTTP transport uses fetch + SSE. Tauri transport uses `invoke()` + `listen("t2ai-event")`. Both expose identical API surface.

**`components/App.jsx`** — Main orchestrator. Manages conversations, streaming state, event handlers, theme.

## Key Design Decisions

### De-anonymization Strategy
Models receive "Response A", "Response B", etc. Backend creates `label_to_model` mapping. Frontend displays model names in bold for readability. Users see explanation that original evaluation used anonymous labels.

### Error Handling
Continue with successful responses if some models fail. Never fail the entire request due to single model failure.

### Upload Route Split
Non-streaming: `/message` (JSON) and `/message/upload` (multipart). Streaming: `/message/stream` (multipart). The frontend chooses the correct route based on whether files are present.

### Data Paths
Web mode: `./data` (configurable via `DATA_DIR` env). Tauri mode: macOS Application Support. Migration utility copies between them.

## Port Configuration

- Web backend: 8001
- Frontend dev server: 3000
- CORS: allows localhost:3000 and localhost:5173

## Streaming Events

Both adapters emit the same event types in order:
`upload_processing_start` → `upload_processing_complete` → `stage1_start` → `stage1_complete` → `stage2_start` → `stage2_complete` → `stage3_start` → `stage3_complete` → `title_complete` (optional) → `complete`

Error at any point: `error` event with `message` field.

## Development Commands

```bash
# Full CI
./scripts/ci.sh

# Rust
cargo fmt --all --check
cargo clippy --workspace -- -D warnings
cargo test -p t2ai-core
cargo build --workspace

# Frontend
cd frontend && npm run lint && npm run build

# Web mode
cargo run -p t2ai-server                   # backend
npm run dev --prefix frontend              # frontend

# Native mode
cargo tauri dev

# Data migration
cargo run -p t2ai-server -- --migrate /path/to/dest
```

## Test Coverage (52 tests)

- Config: load defaults, roundtrip, invalid fallback
- Storage: CRUD, messages, attachments, JSON roundtrip
- Council: ranking parser (4 cases), aggregate rankings (2 cases)
- Attachments: validation, extraction, truncation, context building (16 tests)
- Contract: event ordering, payload verification, SSE/Tauri format parity (10 tests)
- Migration: empty, copy, skip existing, uploads, secrets

## Common Gotchas

1. **Upload route**: Non-streaming uploads go to `/message/upload`, not `/message`. The frontend transport handles this automatically.
2. **CORS**: Frontend must match allowed origins in server `main.rs`.
3. **API key**: Loaded from `OPENROUTER_API_KEY` env var, with `.env` file fallback.
4. **Tauri events**: Need `core:event:allow-emit` and `core:event:allow-listen` permissions in `capabilities/default.json`.
5. **Ranking parse failures**: Fallback regex extracts any "Response X" patterns in order.

## Data Flow

```
User Query
    ↓
Stage 1: Parallel queries → [individual responses]
    ↓
Stage 2: Anonymize → Parallel ranking queries → [evaluations + parsed rankings]
    ↓
Aggregate Rankings → [sorted by avg position]
    ↓
Stage 3: Chairman synthesis with full context
    ↓
Return: {stage1, stage2, stage3, metadata}
    ↓
Frontend: Display with tabs + validation UI
```
