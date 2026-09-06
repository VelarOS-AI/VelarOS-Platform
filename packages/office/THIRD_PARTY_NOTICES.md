# Third-party notices for @velaros-ai/office

The vendored PowerPoint generation runtime is derived from `pptxgenjs` version
`4.0.1`, licensed under the MIT License, copyright 2015-2022 Brent Ely.
The complete license text is in
`third-party-licenses/pptxgenjs-MIT.txt`.

VelarOS applies narrow local security patches to the ESM runtime: UUID generation
uses Web Crypto, and presentation media paths reject archive-root traversal. The
public API and upstream TypeScript declarations are unchanged.

PptxGenJS continues to load `jszip` as an external dependency. That dependency
is installed separately and retains its own license and notices.
