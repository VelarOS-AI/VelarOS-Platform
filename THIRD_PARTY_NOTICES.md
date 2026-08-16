# Third-party notices

VelarOS Platform includes and depends on third-party software. Dependencies installed from package manifests retain their own licenses and notices.

## Bundled Chrome DevTools code

`packages/browser/vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs` is generated from:

- `chrome-devtools-frontend` version `1.0.1652307`, licensed under BSD-3-Clause, copyright The Chromium Authors;
- integration patterns adapted from `chrome-devtools-mcp`, licensed under Apache-2.0, copyright Google LLC.

The package-local notice and license texts are distributed beside the generated bundle in `packages/browser/vendor/devtools-performance-engine/`.

The bundle must be regenerated from documented, pinned inputs. Do not edit the generated JavaScript directly or remove upstream attribution.
