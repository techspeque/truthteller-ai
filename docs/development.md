# Development Guide

This guide is for contributors working on TruthTeller AI itself.

## Repo Layout

```text
truthteller-ai/
  backend/           Tauri desktop adapter and packaging config
  crates/core/       Shared Rust domain logic
  crates/server/     Axum HTTP and SSE adapter
  docs/              User, developer, and release docs
  frontend/          Next.js UI
  scripts/           CI, release, coverage, prerequisite, and version scripts
```

## Architecture Rules

TruthTeller AI is intentionally split into four layers.

### Rust Core

`crates/core` owns correctness-sensitive product behavior:

- council stage orchestration
- attachment processing
- OpenRouter request behavior
- conversation persistence
- config and credential-aware responses
- shared event and API data models

If a behavior must be consistent in both web and native modes, it should live here.

### Web Adapter

`crates/server` is the browser-facing adapter. It should stay thin:

- register routes
- validate request payloads
- translate core errors into HTTP responses
- stream council events over SSE

It should not reimplement council logic or persistence rules.

### Tauri Adapter

`backend` is the native desktop shell. It should stay thin:

- register Tauri commands
- bridge file uploads and native events into shared core calls
- expose native-only helpers such as opening logs folders
- keep platform behavior isolated from product behavior

### Frontend

`frontend` renders the app state and calls transport methods. It should not own shared business rules for stages, storage, or config invariants.

The frontend can shape UX, but the product rules should stay in Rust whenever possible.

## Local Development

There are two normal ways to run the app locally.

### Web Mode

Run the backend:

```bash
cargo run -p t2ai-server
```

Run the frontend in a second terminal:

```bash
npm run dev --prefix frontend
```

The frontend runs on `http://localhost:3000`. The backend runs on `http://localhost:8001`.

### Native Mode

From the repo root:

```bash
cargo tauri dev
```

This launches the Next.js dev server through Tauri and opens the native app window.

## Frontend Workflow

Common commands:

```bash
npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run coverage --prefix frontend
npm run build --prefix frontend
```

Prefer frontend tests when changing:

- transport behavior
- stream-event handling
- settings UX and validation
- council stage rendering
- insights and rerun controls

## Backend Workflow

Common commands:

```bash
cargo fmt --all --check
cargo clippy --workspace -- -D warnings
cargo test -p t2ai-core
cargo build --workspace
```

Prefer Rust-core tests whenever you change:

- council stage behavior
- OpenRouter request policy
- attachment extraction
- conversation persistence
- shared types or contracts
- config validation and defaults

## Working Across Runtimes

Remember that the same product surface exists in both web and native modes.

When you change:

- API payloads
- stream event shapes
- config models
- conversation message structure

validate the effect on both:

- `crates/server`
- `backend`
- `frontend/src/lib/transport.ts`

## Documentation Expectations

When behavior changes, update the relevant docs in the same change:

- `README.md` for entry-point project information
- `docs/getting-started.md` for user-facing workflow or install changes
- `docs/development.md` for contributor workflow or architecture changes
- `docs/testing-and-release.md` for pipeline, versioning, or release changes
- `docs/releases/vX.Y.Z.md` for tagged release summaries

## Current High-Value Areas

The app already supports the core multi-model workflow. The highest-value improvements tend to be:

- stronger council and transport test coverage
- better native and web parity validation
- release and packaging reliability
- clearer user-facing docs around credentials, uploads, and rerun flows

## Related Docs

- [Getting Started](./getting-started.md)
- [Testing And Release](./testing-and-release.md)
- [Architecture](./architecture.md)
- [Docs Index](./README.md)
