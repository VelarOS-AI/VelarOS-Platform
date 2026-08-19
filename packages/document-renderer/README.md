# Velar Document Renderer

An independently installed command capability pack for Office and PDF rendering. It is not a
Velar Host module, is not registered in the Host tool catalog, and has its own native dependencies
and release lifecycle.

The executable accepts exactly one JSON request per process and writes exactly one JSON response.
Requests can be sent on standard input or passed with `--request-json`. Run
`velar-document-renderer describe` to inspect the supported protocol and formats.

All input and output paths are confined to an explicit `projectRoot`, including checks against
symlink escapes. Supported operations are:

- `render-office`: `.docx`, `.pptx`, or `.xlsx` to `.html` or `.png`.
- `render-pdf-page`: one `.pdf` page to `.png`.
