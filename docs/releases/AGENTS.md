# Coding Agent Release Protocol

You are an automated release assistant. Your goal is to move the project from its current state to a verified new version. Strictly follow this sequence.

## Phase 1: Pre-Flight Verification

Run the following command to ensure the codebase is healthy and current versions are synchronized: ./scripts/ci.sh --skip-prereqs

Stop Condition: If any check (Lint, Test, Clippy, or Version Check) fails, abort and report the error. Do not proceed.

## Phase 2: Version Determination & Application

1. Analyze Changes: Review all commits/file changes since the last version tag.
2. Determine SemVer:
    Major ($x.0.0$): Breaking changes or incompatible API updates.
    Minor ($0.x.0$): New features (backwards compatible).
    Patch ($0.0.x$): Bug fixes or internal refactors.
3. Execute Bump: Run the versioning script to update `VERSION`, the shipped crate manifests, `tauri.conf.json`, and `package.json`: ./scripts/version.sh set <NEW_VERSION_NUMBER>
4.Validate Bump: Run `./scripts/version.sh check` to confirm synchronization.

## Phase 3: Documentation & Artifacts

1. Release Notes: Create a new file `./docs/releases/v<NEW_VERSION>.md`. Categorize changes into:
    Features (New functionality)
    Fixes (Bug resolutions)
    Chore (Maintenance/Docs)
2. Release Doc Contract: The release note filename must exactly match the git tag without modification after the `v` prefix. Example: tag `v0.1.1` must use `docs/releases/v0.1.1.md`. The GitHub release workflow links to this exact tagged file.
3. README Update: Add a markdown link to the new release note in the `README.md` and `docs/README.md`.
4. Doc Update: Update any relevant API or user documentation based on the code changes, including install or release instructions if platform coverage changes.

## Phase 4: Release Workflow Expectations

1. Release Body Link: Ensure the GitHub release page will be rendered from `.github/release-body.md` and will link to the new versioned doc in `docs/releases/`.
2. Release Metadata Check: CI must verify the tagged release has a matching `docs/releases/v<NEW_VERSION>.md` file before starting platform builds.
3. Platform Coverage: Release automation is expected to publish artifacts for macOS, Linux, and Windows. If release-related changes remove or add platform support, update the workflows and docs in the same change.

## Phase 5: Git Execution Commands

Provide the user with the exact sequence of commands to finalize the release. Output the commit message alone first, then the command block:

Commit Message:
`release: v<NEW_VERSION>`

Execution Block:

```bash
git add .
git commit -m "release: v<NEW_VERSION>"
git tag -a v<NEW_VERSION> -m "Release v<NEW_VERSION>"
git push origin main --tags
```
