# Quality gate coverage

This page maps the maintained repository gates to their ownership. The root `package.json` is the canonical execution graph; update this page whenever a gate is added, removed, or renamed.

## Full validation

```bash
bun run check
```

The full check builds every package, runs type checking, lint, tests, maintained suites, and all repository gates. A package-local check is useful during development but is not equivalent to the full repository result.

## Domain gates

| Domain | Gate | Responsibility |
| --- | --- | --- |
| Kernel | `check:kernel-schemas` | Wire-schema compatibility snapshots |
| Kernel | `check:kernel-arch` | Dependency direction and package contract |
| Core | `check:core-semantic-vocabulary` | Keeps product-domain vocabulary out of the shared core |
| Agent | `check:agent-schemas` | Tool and protocol schema stability |
| Agent | `check:agent-arch` | Agent package dependency boundaries |
| Agent | `check:agent-browser` | Browser-facing Agent contracts |
| Agent | `check:conversation-semantics` | Conversation state semantics |
| Capabilities | `check:capabilities-schemas` | Capability input-schema snapshots |
| Capabilities | `check:capabilities-arch` | Ownership and dependency boundaries across capability packages |
| Model | `check:model-arch` | Model package boundaries and publication metadata |
| Memory | `check:memory-boundaries` | Memory, knowledge, and Kernel direction rules |
| Memory | `check:memory-knowledge-profile` | Knowledge-profile integration |
| Memory | `probe:memory` | Storage, authority, replay, query, file, vector, and capability probes |
| UI | `check:ui-form-closure` | Component-form closure |
| UI | `check:ui-color-literal` | Design-token color policy |
| UI | `check:ui-hook-deps` | React hook dependency regression gate |
| UI | `check:ui-package-contracts` | Package export and metadata contracts |
| UI | `check:ui-component-library` | Component API generation, documentation freshness, and isolation |
| HTML Artifacts | `check:html-artifacts-package` | Package contract and distributable output |
| Project | `check:project-arch` | Package shape and host/capability boundaries |
| Project | `check:project-agent-contract` | Project tool integration contract |
| Agent Lab | `check:agent-lab-package` | Evaluation package contract and tests |

## Repository-wide gates

| Gate | Responsibility |
| --- | --- |
| `check:code-style` | Prevents new architecture/style violations beyond the reviewed baseline |
| `check:dependency-security` | Runs patched-dependency probes and the documented dependency audit policy |
| `check:devtools-performance-engine` | Rebuilds and byte-compares the pinned third-party performance bundle |
| `check:public-readiness` | Verifies public metadata, licenses, links, secret patterns, and local-path hygiene |
| `check:platform-generation` | Ensures all packages declare the same Platform generation |

## Baselines

Baselines are ratchets, not exemptions for new code. A change may reduce a baseline after fixing findings; it must not regenerate a larger baseline to make a gate pass. High-risk categories such as swallowed errors and unlogged failures should be removed before cosmetic categories.

## Pull request expectation

Pull requests should report the exact commands run and separate failures introduced by the change from known repository baselines. A partial domain check must be described as partial validation.
