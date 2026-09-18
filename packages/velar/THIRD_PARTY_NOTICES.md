# Third-party notices for @velaros-ai/velar

## Browser: Chrome DevTools code

`browser/vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs` is
generated from:

- `chrome-devtools-frontend` version `1.0.1652307`, licensed under
  BSD-3-Clause, copyright The Chromium Authors; and
- integration patterns adapted from `chrome-devtools-mcp` commit
  `2d944f9f4e6b107a6b42fb82c7e957384883bf7d`, including
  `src/devtools/DevtoolsUtils.ts`, `src/tools/performance.ts`, and
  `src/trace-processing/parse.ts`, licensed under Apache-2.0, copyright Google
  LLC.

The complete license texts and regeneration instructions are in
`browser/vendor/devtools-performance-engine/`.

## Office: PptxGenJS presentation generation runtime

The vendored PowerPoint generation runtime in `office/vendor/pptxgenjs/` is
derived from `pptxgenjs` version `4.0.1`, licensed under the MIT License,
copyright 2015-2022 Brent Ely.
The complete license text is in
`third-party-licenses/pptxgenjs-MIT.txt`.

VelarOS applies narrow local security patches to the ESM runtime: UUID generation
uses Web Crypto, and presentation media paths reject archive-root traversal. The
public API and upstream TypeScript declarations are unchanged.

PptxGenJS continues to load `jszip` as an external dependency. That dependency
is installed separately and retains its own license and notices.
