# Platform 0.6.20 Windows execution release

Platform 0.6.20 publishes the Windows execution and shell lifecycle work completed after 0.6.18,
including the release-gate corrections found while validating the initial 0.6.19 candidate.

## Published packages

| Package | Version |
| --- | --- |
| `@velaros-ai/system` | `1.1.10` |
| `@velaros-ai/project` | `2.0.13` |
| `@velaros-ai/office` | `1.1.10` |

## Changes

- System owns Windows shell discovery, output decoding, managed process identity, tree termination,
  and the native process host used by product runtimes.
- Project exposes the command execution metadata required by Desktop without duplicating System
  contracts.
- Office uses the shared shell boundary for quoted document conversion commands on Windows.
- The release runner normalizes Windows tar entry separators before validating package contents.

The release path validates the complete package topology and publishes these three changed
packages from their immutable package-version tags.
