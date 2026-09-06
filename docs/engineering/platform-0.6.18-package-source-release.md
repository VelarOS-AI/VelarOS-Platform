# Platform 0.6.18 package source release

Platform 0.6.18 is a metadata-only follow-up to the first public release. GitHub Packages treated
the npm-style `git+https` repository value in three package versions as a non-GitHub source, so
their package pages could not be linked through the normal repository picker. The manifests now
use the canonical GitHub HTTPS URL declared by the workspace root.

## Published packages

| Package | Version |
| --- | --- |
| `@velaros-ai/agent` | `0.6.14` |
| `@velaros-ai/memory` | `0.4.4` |
| `@velaros-ai/ui` | `0.2.31` |

The JavaScript APIs and runtime behavior of these packages are unchanged from Platform 0.6.17.
The version increments make the corrected package metadata immutable and independently verifiable
in the registry. Existing consumers can remain on the 0.6.17 package set until their next ordinary
dependency update.

## Release verification

The `v0.6.18` tag identifies the source for this follow-up train. The maintained local release path
publishes only `agent`, `memory`, and `ui`, while still validating the complete 16-package topology,
running the full quality gate, rebuilding the repository, and hashing the exact tarballs sent to
GitHub Packages. GitHub Actions is not used for publication.
