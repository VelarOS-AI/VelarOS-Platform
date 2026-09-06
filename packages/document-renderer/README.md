# Velar Document Renderer

An independently installed command capability pack for Office and PDF rendering. It is not a
VelarOS Terminal module, is not registered in the Terminal tool catalog, and has its own native dependencies
and release lifecycle.

The executable accepts exactly one JSON request per process and writes exactly one JSON response.
Requests can be sent on standard input or passed with `--request-json`. Run
`velar-document-renderer describe` to inspect the supported protocol and formats.

On macOS, a local development pack can use ad-hoc signing:

```sh
node scripts/document-renderer/build-product.mjs --adhoc
```

A Developer ID build requires the signing identity to be supplied explicitly through
`VELAROS_RENDERER_CODESIGN_IDENTITY` (or the shared `VELAROS_HOST_CODESIGN_IDENTITY`). Add
`--notarize` when producing a notarized release candidate; `APPLE_KEYCHAIN_PROFILE` selects the
notarytool profile and defaults to `velaros-notary`.

All input and output paths are confined to an explicit `projectRoot`, including checks against
symlink escapes. Supported operations are:

- `render-office`: `.docx`, `.pptx`, or `.xlsx` to `.html` or `.png`.
- `render-pdf-page`: one `.pdf` page to `.png`.
