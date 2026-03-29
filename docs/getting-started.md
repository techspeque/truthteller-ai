# Getting Started

This guide is for people who want to run TruthTeller AI locally and exercise the current product without digging through the repo first.

## What TruthTeller AI Is

TruthTeller AI is a multi-model deliberation app built around a three-stage council workflow:

1. Stage 1: each selected model answers independently
2. Stage 2: models rank the anonymized Stage 1 responses
3. Stage 3: a chairman model synthesizes the final answer

The app also supports:

- multi-turn conversations
- file uploads shared across the whole council
- streaming progress updates
- settings for models, retries, timeouts, and credentials
- post-run insights and rerun controls

## Prerequisites

You need:

- Rust stable toolchain
- Node.js and npm
- an OpenRouter API key

For native desktop development:

- Xcode Command Line Tools on macOS
- Linux Tauri system packages on Ubuntu or Debian-based systems

## Install Dependencies

From the repo root:

```bash
cargo build
npm install --prefix frontend
```

## Configure Your API Key

You can set the OpenRouter API key in either of these ways.

### In The App

1. Open `Settings`
2. Go to `Credentials`
3. Save your OpenRouter API key

### In A Root `.env` File

```bash
OPENROUTER_API_KEY=sk-or-v1-...
```

If `OPENROUTER_BASE_URL` is unset, the app uses `https://openrouter.ai`.

## Fastest Way To Run The App

### Web Mode

Terminal 1:

```bash
cargo run -p t2ai-server
```

Terminal 2:

```bash
npm run dev --prefix frontend
```

Then open `http://localhost:3000`.

### Native Mode

From the repo root:

```bash
cargo tauri dev
```

This starts the frontend dev server and opens the native Tauri window.

## Install From GitHub Releases

If you want the packaged app instead of running from source, download the matching asset from the GitHub Releases page.

### macOS

- download the `.dmg`
- open it and move `TruthTeller AI.app` into `Applications`
- if you use the `.app.tar.gz` archive instead, extract it first and move `TruthTeller AI.app` into `Applications`

### Linux

- on Ubuntu or Debian-based systems, download the `.deb` and install it with `sudo apt install ./<downloaded-asset>.deb`
- on other Linux distributions, download the `.AppImage`, make it executable with `chmod +x <downloaded-asset>.AppImage`, then run it
- if AppImage launch fails, install the FUSE runtime required by your distribution

### Windows

- download the `.msi` installer for the standard install flow
- if you prefer the NSIS build, download and run the `-setup.exe` asset instead
- if SmartScreen warns on an unsigned build, review the publisher details before continuing

## Basic Workflow To Try

To validate the current product path:

1. Create a conversation
2. Ask a question that benefits from multiple perspectives
3. Optionally upload a file such as a `.md`, `.pdf`, or `.docx`
4. Watch Stage 1, Stage 2, and Stage 3 stream into the UI
5. Open `Settings` and confirm your council models and chairman model
6. Use the insights panel to review rankings, timing, and rerun options
7. Try `Re-run Stage 2 + 3` or `Re-run Stage 3 only`
8. Export the conversation to Markdown

## What Works Today

TruthTeller AI currently supports:

- browser-hosted and native desktop modes
- conversation history and deletion
- file-assisted prompts
- three-stage council execution
- retry and rerun flows
- persisted config and stored credentials
- model lookup through OpenRouter
- council insights and timing display
- Markdown export

## Current Limitations

TruthTeller AI does not currently include:

- an in-app updater
- offline model execution
- local model providers out of the box
- mobile clients

Tagged releases are installed manually by downloading new assets from GitHub Releases.

## Where To Go Next

- For project-level context, see [README.md](../README.md)
- For implementation details, see [Development Guide](./development.md)
- For scripts and release flow, see [Testing And Release](./testing-and-release.md)
