# Vendored PptxGenJS runtime

This directory contains the ESM runtime derived from PptxGenJS `4.0.1`
(`pptxgenjs-4.0.1.tgz`) plus reviewed local security patches, alongside the
unchanged upstream TypeScript declarations. The runtime is vendored because the
published PptxGenJS manifest declares `image-size`, although its distributed
runtime does not import or execute that package. Keeping the audited runtime
inside `@velaros-ai/office` avoids installing that unused vulnerable parser for
package consumers.

The local runtime patches replace the UUID helper's `Math.random()` use with Web
Crypto and resolve media relationship paths by segments while rejecting archive
root traversal. Neither patch changes the public API, so the upstream declaration
file remains valid. The package does not ship an upstream source map, and these
small source-level patches therefore have no source map to regenerate.

The runtime still imports `jszip`, which remains a normal direct dependency of
`@velaros-ai/office`. The PptxGenJS MIT license is distributed in
`../../third-party-licenses/pptxgenjs-MIT.txt`.

The repository dependency-security gate pins SHA-256 hashes for the patched
runtime and unchanged declarations, and the public-readiness gate requires this
patch record to ship. Any upgrade must review the upstream and local diffs,
refresh the license notice, and update those hashes deliberately.
