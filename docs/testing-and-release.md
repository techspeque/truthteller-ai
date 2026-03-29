# Testing And Release

This guide describes how TruthTeller AI is validated locally and in CI.

## Fast Path

Run the full CI suite locally on macOS:

```bash
./scripts/ci.sh --platform macos --skip-prereqs
```

On Linux:

```bash
./scripts/ci.sh --platform linux --skip-prereqs
```

`./scripts/ci.sh` runs:

- Rust format checks
- version consistency checks
- Rust clippy
- Rust core tests
- workspace build
- frontend lint
- frontend typecheck
- frontend build

## Frontend Checks

```bash
npm run lint --prefix frontend
npm run typecheck --prefix frontend
npm run test --prefix frontend
npm run coverage --prefix frontend
npm run build --prefix frontend
```

Frontend coverage is currently centered on transport behavior, event handling, and the main app components rather than exhaustive visual snapshot coverage.

## Rust Checks

```bash
cargo fmt --all --check
cargo clippy --workspace -- -D warnings
cargo test -p t2ai-core
cargo build --workspace
```

The most critical backend coverage sits in `crates/core`, where council behavior, attachment processing, storage, and shared contracts are validated.

## Coverage

Run combined coverage with:

```bash
./scripts/coverage.sh
```

That script:

- runs frontend coverage
- runs Rust coverage with `cargo llvm-cov`
- prints frontend, backend, and combined summaries
- prints README badge markdown

If `cargo llvm-cov` is missing, install it with:

```bash
cargo install cargo-llvm-cov --locked
rustup component add llvm-tools-preview
```

## Versioning

TruthTeller AI uses `VERSION` as the source of truth.

Useful commands:

```bash
./scripts/version.sh print
./scripts/version.sh check
./scripts/version.sh set 0.2.0
```

The version script keeps these files aligned:

- `VERSION`
- `crates/core/Cargo.toml`
- `crates/server/Cargo.toml`
- `backend/Cargo.toml`
- `backend/tauri.conf.json`
- `frontend/package.json`

## Release Metadata

Tagged releases require a matching versioned release note:

```text
docs/releases/vX.Y.Z.md
```

The helper script for release metadata is:

```bash
./scripts/release-metadata.sh check --tag v0.2.4
```

It verifies that the release note exists and that the release-body template dependencies are present before publication.

## Release Builds

Create a release bundle on macOS:

```bash
./scripts/release.sh --platform macos
```

On Linux:

```bash
./scripts/release.sh --platform linux
```

On Windows with Git Bash:

```bash
bash ./scripts/release.sh --platform windows
```

Useful flags:

- `--skip-prereqs`
- `--skip-checks`
- `--skip-tests`
- `--clean`
- `--target <triple>`

Release builds currently:

- verify version consistency
- run Rust format and clippy checks unless skipped
- run frontend lint and typecheck unless skipped
- run Rust workspace tests unless skipped
- build Tauri bundles for the host platform

Local release builds are intentionally host-specific. `./scripts/release.sh --platform macos` must run on macOS, `./scripts/release.sh --platform linux` must run on Linux, and `bash ./scripts/release.sh --platform windows` must run on Windows.

## Release Flow

The current tagged release flow is:

1. Run the pre-flight verification suite: `./scripts/ci.sh --skip-prereqs`
2. Choose the next semantic version
3. Apply it with `./scripts/version.sh set X.Y.Z`
4. Re-check version sync with `./scripts/version.sh check`
5. Write release notes at `docs/releases/vX.Y.Z.md`
6. Commit the release change
7. Create and push the annotated tag: `git tag -a vX.Y.Z -m "Release vX.Y.Z" && git push origin main --tags`

## CI/CD

GitHub Actions workflows live in:

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`

Those workflows delegate to the shared shell scripts in `scripts/` instead of re-encoding the pipeline in YAML.

For tagged releases, `.github/workflows/release.yml` now:

- verifies tag and version alignment
- verifies a matching `docs/releases/vX.Y.Z.md` file exists
- builds macOS artifacts on `macos-14`
- builds Linux artifacts on `ubuntu-22.04`
- builds Windows artifacts on `windows-2022`
- renders the GitHub release body from `.github/release-body.md`
- publishes all artifacts into one GitHub release

The release page links back to the versioned release notes using the same git tag, so older releases always point at the correct documentation snapshot.

## Related Docs

- [Getting Started](./getting-started.md)
- [Development Guide](./development.md)
- [Architecture](./architecture.md)
- [README.md](../README.md)
