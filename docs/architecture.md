# TruthTeller AI Architecture

## Overview

TruthTeller AI uses a shared-core architecture:

- `frontend`: `Next.js` app for the UI
- `backend`: `Tauri` desktop shell and native adapter
- `crates/server`: `axum` web adapter for browser-hosted mode
- `crates/core`: shared Rust domain logic

The key rule is simple: council behavior, storage rules, config handling, and model orchestration live in Rust. The frontend renders state and triggers transport calls.

## Why This Stack

### Next.js

`Next.js` provides the React application shell, routing entry point, component structure, and frontend tooling.

Use it for:

- conversation and composer UI
- streaming event rendering
- settings and credential management
- council stage panels
- insights and rerun controls
- export and navigation workflows

Avoid pushing product rules into frontend-only helpers when the same behavior must stay consistent across web and native modes.

### Tauri

`Tauri` is the native desktop adapter. It owns:

- desktop window lifecycle
- native command registration
- Tauri event emission for streaming council updates
- app data directories and log-folder access
- native packaging for macOS, Linux, and Windows

The Tauri layer should stay thin. It should delegate council, storage, and config behavior to `t2ai-core`.

### Axum Server

`crates/server` is the web adapter. It exposes HTTP and SSE endpoints that mirror the same product surface as the native app:

- conversation CRUD
- message send and streaming
- retry and rerun flows
- config and credential endpoints
- model lookup
- storage info

This keeps browser mode and native mode on the same conceptual contract even though the transport differs.

### Rust Core

`crates/core` owns the durable and correctness-sensitive parts of the product:

- council orchestration
- OpenRouter request logic
- app config models and persistence
- conversation storage
- upload extraction and shared file context building
- streaming event contracts
- migration helpers

If a behavior must be consistent across transports, it should live here.

## Repository Layout

```text
truthteller-ai/
  backend/           Tauri adapter, native commands, packaging config
  crates/
    core/            Shared Rust domain logic
    server/          Axum web server adapter
  docs/              User, developer, and release docs
  frontend/          Next.js UI
  scripts/           CI, release, coverage, prerequisite, and version scripts
```

## Runtime Modes

TruthTeller AI runs in two delivery modes from the same product core.

### Web Mode

In web mode:

- `crates/server` serves HTTP APIs and SSE streams on port `8001`
- `frontend` runs as a normal Next.js app on port `3000`
- the frontend transport uses `fetch()` and SSE parsing

This is the fastest mode for UI iteration and browser-based debugging.

### Native Mode

In native mode:

- `backend` hosts the same frontend in a Tauri window
- the frontend transport uses Tauri IPC commands and event listeners
- logs and data directories resolve through platform-native paths

Native mode is the packaged desktop product surface.

## Shared Transport Pattern

The frontend talks to a runtime-agnostic transport interface in `frontend/src/lib/transport.ts`.

That transport exposes the same product operations regardless of runtime:

- health check
- conversations CRUD
- send message and stream events
- config and credential operations
- model fetch
- retry and rerun flows
- open logs folder in native mode

This keeps the UI mostly unaware of whether it is running in a browser or in Tauri.

## Core Domain Areas

`crates/core` is organized around product capabilities rather than transport concerns.

Important areas include:

- `attachments`: uploaded file extraction and Stage 1 query context assembly
- `config`: persisted runtime configuration and credential-aware responses
- `council`: Stage 1, Stage 2, and Stage 3 orchestration
- `openrouter`: model queries, retries, and request options
- `storage`: conversation persistence
- `contract`: event contract validation
- `types`: shared data models used across adapters

## Frontend Responsibilities

The frontend should stay thin and interaction-focused.

It should own:

- component state
- staged loading and event rendering
- form handling and validation UX
- tabs, settings panels, and insights presentation
- transport selection and client-side error display

It should not own:

- council-stage business logic
- storage format rules
- attachment extraction rules
- config invariants that must be shared across runtimes

## Adapter Responsibilities

Both adapters should translate product operations rather than redefine them.

### Tauri Adapter

The Tauri layer should:

- expose typed commands
- map native file uploads into shared core types
- emit `t2ai-event` updates during council runs
- keep native-only actions isolated, such as opening the logs folder

### Web Adapter

The web server should:

- expose stable JSON and SSE endpoints
- validate request payloads
- translate core errors into HTTP responses
- avoid duplicating council or storage logic already owned by `t2ai-core`

## Data And Persistence

Runtime data is stored under the active data directory.

Current persisted surfaces include:

- conversations
- uploaded files
- `config.json`
- `secrets.json`
- native logs in Tauri mode

The web server defaults to `./data`. Native mode uses the platform app-data directory.

## Architectural Guardrails

### Keep Core Logic In Rust

Council orchestration, retry policy, storage layout, and config rules should not drift between runtimes.

### Keep Transports Replaceable

The UI should depend on typed product operations, not adapter-specific assumptions.

### Keep Adapters Thin

Native and web adapters should mostly translate requests, not become alternate implementations of the app.

### Prefer Additive Evolution

New delivery surfaces or providers should extend existing contracts rather than fork product behavior.
