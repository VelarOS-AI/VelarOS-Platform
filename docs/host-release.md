# Velar Host packaging and release

Velar Host is an independently installable product built from `products/host` and
`@velaros-ai/serve-host`. It does not own a web control page: starting the installed product opens
or reuses a terminal/console and prints the capability summary, extension pairing code, connection
events, and tool activity there.

## Native installers

Installers are always built on their target operating system:

```sh
# Apple Silicon macOS, Developer ID signing + notarization
bun run package:host:mac

# Apple Silicon macOS development package, ad-hoc signing only
bun run package:host:mac:dev

# Windows x64, NSIS installer
bun run package:host:win

# Linux x64, AppImage
bun run package:host:linux
```

Outputs and their identity manifests are written under `release/host/`. A Host installer is
identified by `source commit + Host version + platform + file name + byte size + SHA-256`. A valid
matching macOS artifact is reused during recovery; upload, workflow, manifest, or network failures
must not trigger another Apple notarization.

macOS release packaging requires the Developer ID Application identity and the same
`APPLE_KEYCHAIN_PROFILE` policy as Desktop. Windows is currently packaged without code signing;
Linux AppImage packaging requires a native `appimagetool` executable.

## Official artifact repository

All VelarOS product installers share the private `Error-Zhang/VelarOS-Releases` artifact repository.
Product-prefixed immutable tags keep their versions independent:

- Desktop: `desktop-v<version>`
- Host: `host-v<version>`
- Resource plugins: `plugin-<id>-v<version>`

The repository stores binaries and release manifests only. It must not contain source, credentials,
environment files, or provider keys.

Host uses the same split build model as Desktop: the release Mac builds, signs, notarizes, and
stages `darwin-arm64`; `.github/workflows/release-host.yml` builds and stages `win32-x64` and
`linux-x64` on GitHub. The final `candidate-host-<channel>.json` is uploaded only after all three
platform manifests match the same source commit and version.

## One-command release

Configure the Platform repository variable `VELAROS_RELEASE_REPOSITORY` and the
`release-candidates` environment secret `VELAROS_RELEASE_REPO_TOKEN`, then run from a clean,
pushed Apple Silicon checkout:

```sh
bun run release:host --channel stable
```

Useful safe modes:

```sh
bun run release:host --check-only
bun run release:host --channel canary --dry-run
```

The release command never changes a version, commits, or pushes source. Replacing bytes under an
existing version is rejected unless `--replace-existing` is explicit, and that option is reserved
for repairing a known damaged candidate.
