# Quality gate coverage

This page maps the maintained repository gates to their ownership. The root `package.json` is the canonical execution graph; update this page whenever a gate is added, removed, or renamed.

## Full validation

```bash
bun run check
```

The full check builds every package, runs type checking, lint, formatting, tests, maintained suites, and all repository gates. A package-local check is useful during development but is not equivalent to the full repository result.

## Domain gates

| Domain | Gate | Responsibility |
| --- | --- | --- |
| Kernel | `check:kernel-schemas` | Wire-schema compatibility snapshots |
| Kernel | `check:kernel-arch` | Dependency direction and package contract |
| Core | `check:core-semantic-vocabulary` | Keeps product-domain vocabulary out of the shared core |
| Agent | `check:agent-schemas` | Tool and protocol schema stability |
| Agent | `check:agent-arch` | Agent package dependency boundaries |
| Agent | `check:agent-public-api` | Published entrypoints, declaration snapshots, and compatibility alias policy |
| Agent | `check:agent-browser` | Browser-facing Agent contracts |
| Agent | `check:conversation-semantics` | Conversation state semantics |
| Capabilities | `check:capabilities-arch` | Capability unit contracts, host boundaries, and retired package ownership |
| Ownership | `check:module-ownership` | Unified contract/types/impl/utils for every registered module; product API registration and documented injection contracts; class APIs beside implementations; data-only types and portable boundaries; registered implementation layers and tuning; operation-definition locations and generated surfaces; interface-controlled exports; registered environment variables and bounded lazy imports; browser-safe value chains; package entry mapping, module cards and executable invariant registries. See [module ownership](architecture/module-ownership.md). |
| Model | `check:model-arch` | Model package boundaries and publication metadata |
| Project | `check:project-arch` | Package shape and host/capability boundaries |
| Agent Lab | `check:agent-lab-package` | Evaluation package contract and tests |

## Repository-wide gates

| Gate | Responsibility |
| --- | --- |
| `check:format` | Checks repository Prettier formatting |
| `check:package-pack-boundary` / `check:package-pack-safety` | Enforces isolated temporary pack directories and verifies safe packing |
| `check:host-contract-consumer` | Verifies consumers of the published host contracts |
| `check:release-source` | Validates local release identity and archive boundaries |
| `check:readme-examples` | Checks module README examples against actual public TypeScript contracts |
| `check:lockfile-consistency` | Keeps workspace declarations and lockfile metadata aligned |
| `check:error-construction` | Enforces Core-owned runtime errors |
| `check:dependency-licenses` | Verifies the dependency license policy |
| `check:script` / `check:act-catalog` | Verifies generated model declarations, templates and Act documentation |
| `check:package-catalog` | Verifies the generated package inventory |
| `check:code-style` | Requires zero language-level architecture/style errors without a baseline |
| `check:dependency-security` | Runs patched-dependency probes and the documented dependency audit policy |
| `check:devtools-performance-engine` | Rebuilds and byte-compares the pinned third-party performance bundle |
| `check:public-readiness` | Verifies public metadata, licenses, links, secret patterns, and local-path hygiene |
| `check:platform-generation` | Ensures all packages declare the same Platform generation |

For runner and platform limitations, see [testing and platform support](engineering/testing.md).

## Baselines

Domain compatibility baselines are ratchets, not exemptions for new code. A change may reduce a domain baseline after fixing findings; it must not regenerate a larger baseline to make a gate pass. `check:code-style` deliberately has no baseline: language-level errors must be fixed in source. High-risk categories such as swallowed errors and unlogged failures should be removed before cosmetic categories.

## Pull request expectation

Pull requests should report the exact commands run and separate failures introduced by the change from known repository baselines. A partial domain check must be described as partial validation.
