## Install

Full release notes: [__RELEASE_DOC_PATH__](__RELEASE_DOC_URL__)

### macOS

Download the `.dmg` asset from this release, open it, and move `TruthTeller AI.app` into `Applications`.

If you prefer the archive build, download the `.app.tar.gz` asset, extract it, and move `TruthTeller AI.app` into `Applications`.

### Linux

For Ubuntu or Debian-based systems, download the `.deb` asset and install it with:

```bash
sudo apt install ./<downloaded-asset>.deb
```

For other Linux distributions, download the `.AppImage` asset, make it executable, and run it:

```bash
chmod +x <downloaded-asset>.AppImage
./<downloaded-asset>.AppImage
```

If your desktop blocks AppImages by default, make sure `libfuse2` or the equivalent FUSE runtime is installed on your system.

### Windows

Download the `.msi` installer for the standard Windows installation flow.

If you prefer the NSIS build, download the `-setup.exe` asset and run it directly.

## Notes

- Release artifacts are built for macOS, Linux, and Windows in CI.
- Full usage and local setup docs live in [`docs/getting-started.md`](__GETTING_STARTED_URL__).
