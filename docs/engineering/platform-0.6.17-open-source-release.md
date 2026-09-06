# Platform 0.6.17 open-source release

Platform 0.6.17 is the first release from the public VelarOS Platform source repository. The
published scope is this repository: the shared contracts, Kernel, Agent runtime, reusable
capabilities, UI, evaluation tools, and the independent Document Renderer capability pack. Product
repositories and deployment configuration remain separate from the Platform source boundary.

## Public history boundary

The first public push rewrites the existing Platform commit and annotated-tag metadata to use the
maintainer's GitHub noreply identity. It also removes developer-machine paths, retired signing
identity data, and credentials found only in unreachable or historical objects. The former macOS
computer helper lineage is removed from every published revision; the current helper is an
independent implementation built against the documented sidecar protocol and shared tests.

Because commit and tag object IDs change, clones made before the public cutover must be replaced
with a fresh clone. Do not merge or push an older clone into the public repository.

## Package versions

| Package | Version |
| --- | --- |
| `@velaros-ai/core` | `0.4.1` |
| `@velaros-ai/kernel` | `0.2.2` |
| `@velaros-ai/agent` | `0.6.13` |
| `@velaros-ai/agent-lab` | `0.1.1` |
| `@velaros-ai/browser` | `0.2.19` |
| `@velaros-ai/cli` | `0.2.16` |
| `@velaros-ai/computer` | `0.2.15` |
| `@velaros-ai/project` | `2.0.11` |
| `@velaros-ai/development` | `1.1.3` |
| `@velaros-ai/html-artifacts` | `0.1.5` |
| `@velaros-ai/memory` | `0.4.3` |
| `@velaros-ai/model` | `0.6.1` |
| `@velaros-ai/office` | `1.1.8` |
| `@velaros-ai/surface-protocol` | `0.1.1` |
| `@velaros-ai/system` | `1.1.8` |
| `@velaros-ai/ui` | `0.2.30` |

The private Document Renderer workspace package advances to `0.1.4`; its platform archives now
resolve PDF.js and the native Canvas runtime from the Office package that owns them and include the
upstream license and notice material supplied for each bundled runtime component.

## Distribution and security changes

- Every published package contains the Apache-2.0 `LICENSE`, a package `NOTICE`, and any additional
  third-party notices required by files shipped in that package.
- `@velaros-ai/office` carries a reviewed, hash-pinned PptxGenJS 4.0.1 ESM runtime with local
  security patches for Web Crypto UUIDs and archive-safe media paths. PptxGenJS does not execute
  its declared `image-size` dependency, so the vendored runtime removes that unused vulnerable
  parser from consumer installations while retaining JSZip as an ordinary dependency.
- macOS release signing requires an explicitly supplied signing identity. Local development builds
  can select ad-hoc signing.
- CodeQL uploads results to the repository security view in addition to retaining the workflow
  artifact.

GitHub Packages still requires npm registry authentication when installing public packages. Source
access does not require a token.

## Release verification

The `v0.6.17` source tag identifies the complete release train. Before publication, the maintained
local release path performs a frozen install, full build, typecheck, lint and test suite, public
readiness checks, safe tarball creation, and exact local/remote tag verification. Package tarballs
are scanned for source directories, test fixtures, credentials, personal paths, and missing legal
files before the same bytes are published.
