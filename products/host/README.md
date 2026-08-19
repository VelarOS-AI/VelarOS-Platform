# Velar Host product

This directory turns `@velaros-ai/serve-host` into an installable product without adding a web or
Electron control surface. Terminal output is the product interface.

- macOS: `Velar Host.app` opens the system Terminal; the signed and notarized app ships in a DMG.
- Windows: the per-user NSIS installer adds Start menu and desktop shortcuts to the console Host.
- Linux: the AppImage runs in the current terminal or opens an installed terminal emulator.

The standalone runtime defaults to `~/VelarOS` as its project root. Advanced users may pass the
same commands and flags as `velaros serve`, including an explicit `--project-root`.

All installers include the Bun runtime and Computer helper source. Users do not need Node.js or
Bun. Computer control still requires the platform-specific Python runtime, which is installed
explicitly with `computer install`.

Office and PDF rendering are deliberately not part of Host. They are shipped as independent,
on-demand command capability packs with their own native dependencies and release lifecycle.

See [`docs/host-release.md`](../../docs/host-release.md) for native build and release procedures.
