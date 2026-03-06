# TruthTeller AI Frontend

Next.js React frontend for TruthTeller AI. Runs in two modes from the same codebase:

- **Web mode**: served by Next.js dev server, talks to the Rust axum backend over HTTP/SSE.
- **Native mode**: embedded in a Tauri window, talks to the Rust core via IPC commands and events.

## Setup

```bash
npm install
```

## Development

```bash
# Standalone (web mode) — requires the Rust server running on port 8001
npm run dev

# Inside Tauri (native mode) — run from the repo root instead
cargo tauri dev
```

The dev server runs on [http://localhost:3000](http://localhost:3000).

## Build

```bash
npm run build
```

Produces a static export in `out/` (used by Tauri for the native app bundle).

## Lint

```bash
npm run lint
```

## Transport Abstraction

The API layer (`src/lib/transport.js`) auto-detects the runtime:

- If `window.__TAURI_INTERNALS__` exists, it uses **Tauri transport** (`invoke()` for commands, `listen()` for streaming events).
- Otherwise, it uses **HTTP transport** (`fetch()` for REST, SSE reader for streaming).

Both transports expose the same interface to the rest of the app:

```
healthCheck()
listConversations()
createConversation()
getConversation(id)
deleteConversation(id)
sendMessage(id, content, files)
sendMessageStream(id, content, files, onEvent)
getConfig()
getStorageInfo()
updateConfig(config)
setOpenRouterApiKey(apiKey)
clearOpenRouterApiKey()
testOpenRouterApiKey(apiKey?)
getAvailableModels()
retryModels(id, models, userQuery)
rerunAssistant(id, payload)
```

Components import `{ api }` from `@/lib/transport` and are unaware of which transport is active.

## Project Structure

```
src/
  app/
    page.jsx          Next.js App Router entry point
    layout.jsx        Root layout
    globals.css       Global styles
  components/
    App.jsx           Main orchestrator (state, event handling)
    ChatInterface.jsx Chat UI with message list + input
    Sidebar.jsx       Conversation list sidebar
    Settings.jsx      Multi-tab settings (General/Models/Credentials/Advanced)
    Stage1.jsx        Stage 1 tab view
    Stage2.jsx        Stage 2 rankings + aggregate view
    Stage3.jsx        Stage 3 final answer
    CouncilInsights.jsx  Post-run analysis panels
    ...
  lib/
    transport.js      Dual transport abstraction (HTTP / Tauri)
```

## Settings Behavior

Settings includes:
- Dirty state (`Save` disabled until changes exist)
- Inline validation for model + runtime fields
- Restore defaults (`tab` and `all`)
- Credential status display (`configured/source/masked_hint`)
- Credential actions (`Save Key`, `Test Key`, `Clear Key`)
- Runtime controls (`timeout`, `parallelism`, `retries`, `stage2_enabled`, `stage3_model_override`)
- Theme controls (`light`, `dark`, `system`) with immediate apply on save

## Composer and Uploads

- Multi-turn composer is always available
- File types accepted in UI: `.txt`, `.md`, `.markdown`, `.pdf`, `.docx`, `.pptx`
- Streaming upload events handled by app state:
  - `upload_processing_start`
  - `upload_processing_complete`
