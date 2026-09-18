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
| Agent | `check:agent-public-api` | Published entrypoints, declaration snapshots, and compatibility alias policy |
| Agent | `check:agent-browser` | Browser-facing Agent contracts |
| Agent | `check:conversation-semantics` | Conversation state semantics |
| Capabilities | `check:capabilities-arch` | Ownership and dependency boundaries across capability packages |
| Ownership | `check:module-ownership` | A single registered tool file holding every tool definition; data-only contracts with no function types and a dependency-free portable data file; documented interface files split into provides (product face), requires (injection points), and internal; a flat one-class-per-file impl whose classes implement documented interfaces (public members limited to the interface, no public statics, private methods must use instance state, module-level functions only as public factories), layered by a registered file list; flat documented `src/utils/`; interface-controlled exports (entries only re-export; exported types only from provides, requires, or contracts; exported values only contract constant tables or impl instances and factories annotated with public interfaces; no classes, utils functions, or internal interfaces leave the package; the exported data set equals the data referenced by public signatures; no orphan portable types; public interfaces never reference internal ones); registered environment variables; no inline import types or dynamic imports; browser-safe entries; `package.json` exports matching entry files; module cards; and invariant registries (see `docs/architecture/module-ownership.md`) |
| Model | `check:model-arch` | Model package boundaries and publication metadata |
| UI | `check:ui-form-closure` | Component-form closure |
| UI | `check:ui-color-literal` | Design-token color policy |
| UI | `check:ui-hook-deps` | React hook dependency regression gate |
| UI | `check:ui-package-contracts` | Package export and metadata contracts |
| UI | `check:ui-component-library` | Component API generation, documentation freshness, and isolation |
| Project | `check:project-arch` | Package shape and host/capability boundaries |
| Agent Lab | `check:agent-lab-package` | Evaluation package contract and tests |

## Repository-wide gates

| Gate | Responsibility |
| --- | --- |
| `check:code-style` | Requires zero language-level architecture/style errors without a baseline |
| `check:dependency-security` | Runs patched-dependency probes and the documented dependency audit policy |
| `check:devtools-performance-engine` | Rebuilds and byte-compares the pinned third-party performance bundle |
| `check:public-readiness` | Verifies public metadata, licenses, links, secret patterns, and local-path hygiene |
| `check:platform-generation` | Ensures all packages declare the same Platform generation |

## Baselines

Domain compatibility baselines are ratchets, not exemptions for new code. A change may reduce a domain baseline after fixing findings; it must not regenerate a larger baseline to make a gate pass. `check:code-style` deliberately has no baseline: language-level errors must be fixed in source. High-risk categories such as swallowed errors and unlogged failures should be removed before cosmetic categories.

## Pull request expectation

Pull requests should report the exact commands run and separate failures introduced by the change from known repository baselines. A partial domain check must be described as partial validation.
