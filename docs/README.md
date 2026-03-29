# TruthTeller AI Docs

Start with the guide that matches what you need.

## User Guides

- [Getting Started](./getting-started.md): prerequisites, local setup, packaged installs, and the core council workflow to try first

## Developer Guides

- [Development Guide](./development.md): repo layout, architecture boundaries, local workflow, and contributor expectations
- [Testing And Release](./testing-and-release.md): CI commands, coverage, versioning, and tagged release flow

## Product And Platform Docs

- [Architecture](./architecture.md): how the Next.js frontend, Tauri desktop shell, web server, and shared Rust core fit together

## Release Docs

- Versioned release notes live in `docs/releases/vX.Y.Z.md`
- Current release notes: [v0.3.1](./releases/v0.3.1.md)
- Release-note policy and automation expectations live in [docs/releases/AGENTS.md](./releases/AGENTS.md)

Every tagged release must have a matching `docs/releases/vX.Y.Z.md` file committed before the tag is pushed.
