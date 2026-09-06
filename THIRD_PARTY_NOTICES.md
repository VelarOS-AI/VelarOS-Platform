# Third-party notices

VelarOS Platform includes and depends on third-party software. Dependencies
installed from package manifests retain their own licenses and notices. The
items below cover third-party source, generated output, or runtime components
that are copied into this repository or its distribution artifacts.

## Browser: Chrome DevTools code

`packages/browser/vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs`
is generated from:

- `chrome-devtools-frontend` version `1.0.1652307`, licensed under
  BSD-3-Clause, copyright The Chromium Authors;
- integration patterns adapted from `chrome-devtools-mcp` commit
  `2d944f9f4e6b107a6b42fb82c7e957384883bf7d`, including
  `src/devtools/DevtoolsUtils.ts`, `src/tools/performance.ts`, and
  `src/trace-processing/parse.ts`, licensed under Apache-2.0, copyright
  Google LLC.

The package-local notice and license texts are distributed beside the generated
bundle in `packages/browser/vendor/devtools-performance-engine/`. The bundle
must be regenerated from documented, pinned inputs. Do not edit the generated
JavaScript directly or remove upstream attribution.

## UI: Tailwind CSS generated output and default theme values

Published UI styles are compiled with `tailwindcss` version `4.3.3` and
`@tailwindcss/typography` version `0.5.20`, and some foundation token values are
derived from the Tailwind CSS default theme. Both projects are licensed under
the MIT License, copyright Tailwind Labs, Inc. The complete license text is in
`packages/ui/third-party-licenses/tailwindcss-MIT.txt`.

## Office: PptxGenJS presentation generation runtime

The presentation runtime distributed in `packages/office/vendor/pptxgenjs/`
is derived from `pptxgenjs` version `4.0.1`, licensed under the MIT License,
copyright 2015-2022 Brent Ely. The package-local notice and complete license
text are distributed in `packages/office/THIRD_PARTY_NOTICES.md` and
`packages/office/third-party-licenses/pptxgenjs-MIT.txt`.
The distributed ESM runtime includes VelarOS security patches for cryptographic
UUID generation and archive-safe media relationship path resolution; its public
API and upstream TypeScript declarations remain unchanged.

## Manually resolved dependency metadata

The `buffers` version `0.1.1` npm tarball omits both license metadata and a
license file. Debian's reviewed source metadata records the upstream package as
MIT-licensed and identifies James Halliday as the copyright holder. The
evidence URL and exact-version exception are recorded in
`third-party-licenses/dependency-license-overrides.json`; the complete license
text is in `third-party-licenses/buffers-0.1.1-MIT.txt`.

## Document Renderer product archives

Document Renderer archives include a Bun runtime, bundled JavaScript
dependencies, PDF.js worker and font data, and the native `@napi-rs/canvas`
binary. The product build generates `THIRD_PARTY_NOTICES.md` and a
`THIRD_PARTY_LICENSES/` directory from the exact inputs of each archive. Bun's
pinned upstream notice and curated license fallbacks live in
`products/document-renderer/third-party-licenses/`.
