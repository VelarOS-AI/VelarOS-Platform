# Velar Document Renderer product

This product packages `@velaros-ai/document-renderer` as an independently installed command
capability pack. It is never copied into VelarOS Terminal and Terminal has no renderer-specific installer,
module, permission branch, or tool route.

Each platform archive contains one native executable, PDF standard-font data, a capability-pack
manifest, the Apache-2.0 project license and NOTICE, and generated third-party notices with the
license and notice material supplied for the exact bundled and native runtime components. The build
derives the third-party inventory from Bun's bundle metafile and fails if a component has no usable
license material. For the Bun executable, the archive carries the exact upstream `LICENSE.md`,
including its linked-component and relinking notices. Every archive is built and finalized on its
matching native release host: macOS on the local release Mac (including notarization), Windows on
the local release Windows host, and Linux on the local release Linux host.
