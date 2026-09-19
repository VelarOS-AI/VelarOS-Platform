# Vendored PptxGenJS runtime

This directory contains the ESM runtime derived from PptxGenJS `4.0.1`
(`pptxgenjs-4.0.1.tgz`) plus reviewed local security patches, alongside the
unchanged upstream TypeScript declarations. The runtime is vendored because the
published PptxGenJS manifest declares `image-size`, although its distributed
runtime does not import or execute that package. Keeping the audited runtime
inside `@velaros-ai/velar` (its office unit) avoids installing that unused vulnerable parser for
package consumers.

The local runtime patches replace the UUID helper's `Math.random()` use with Web
Crypto and resolve media relationship paths by segments while rejecting archive
root traversal. Neither patch changes the public API, so the upstream declaration
file remains valid. The package does not ship an upstream source map, and these
small source-level patches therefore have no source map to regenerate.

The runtime still imports `jszip`, which remains a normal direct dependency of
`@velaros-ai/velar`. The unit loads this runtime through the package's own
`#pptxgenjs` subpath import, so the source tree and the built `dist/` resolve the
same file. The PptxGenJS copyright and MIT permission notice ships inside the
runtime itself: the upstream header of `pptxgen.ts` is kept verbatim in
`pptxgen.es.js`.

The repository dependency-security gate pins SHA-256 hashes for the patched
runtime and unchanged declarations, and the public-readiness gate requires this
patch record to ship and the runtime to keep carrying that notice. Any upgrade
must review the upstream and local diffs, keep the notice, and update those
hashes deliberately.
