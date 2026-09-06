# Vendored PptxGenJS runtime

This directory contains the ESM runtime and TypeScript declarations from
PptxGenJS `4.0.1` (`pptxgenjs-4.0.1.tgz`). The runtime is vendored because the
published PptxGenJS manifest declares `image-size`, although its distributed
runtime does not import or execute that package. Keeping the audited runtime
inside `@velaros-ai/office` avoids installing that unused vulnerable parser for
package consumers.

The runtime still imports `jszip`, which remains a normal direct dependency of
`@velaros-ai/office`. The PptxGenJS MIT license is distributed in
`../../third-party-licenses/pptxgenjs-MIT.txt`.

The repository dependency-security gate pins SHA-256 hashes for both copied
files. Any upgrade must review the upstream diff, refresh the license notice,
and update those hashes deliberately.
