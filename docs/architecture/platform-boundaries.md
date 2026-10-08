# Platform boundaries

## Product position

VelarOS is a personal AI operating system and an ecosystem of AI applications. VelarOS Kernel is the common foundation that lets those applications reuse execution, capabilities, memory, permissions, context, state, and APIs.

VelarOS Desktop is the first shipping product, desktop shell, validation product, and reference integration. Desktop is important, but its current workspaces and UX do not define the final scope of VelarOS or the Platform.

## Ownership

| Owner | Responsibilities |
| --- | --- |
| VelarOS Platform | Kernel contracts and runtime, Agent runtime, model adapters, reusable capabilities, memory, context planning, and evaluation |
| VelarOS UI | Shared UI components, HTML artifacts and the component-library product |
| Product hosts | Native process integration, product composition, user-facing policy, account/session adapters, packaging, and product-specific persistence roots |
| Cloud services | Accounts, entitlements, organization policy, remote service state, and service-side enforcement |
| Mods | Declared contributions behind the versioned mod envelope and the permissions granted by a host |

Product hosts depend on Platform packages through published APIs. Platform packages do not import product source code, private product prompts, host UI, product configuration files, or product-only persistence.
VelarOS Terminal is one such product host and owns its final Host composition. Host-neutral remote-node
transport, MCP adaptation, Act sessions, and model profiles are Platform domain responsibilities;
products supply native lifecycle, persistence, credentials, policy, and UI adapters. The complete owner
decision and clean-break migration are recorded in
[Platform boundaries](platform-boundaries.md).

## Contract authority

Authority is public and local to the owning repository:

1. versioned schemas, exported types, and executable conformance tests;
2. package READMEs and maintained domain specifications;
3. accepted architecture decision records;
4. consumer integration documentation.

A lower layer cannot override a higher layer. Consumer documentation may explain an adapter, but it cannot redefine Platform semantics. No private repository, local file, chat transcript, or unpublished roadmap is a normative dependency.

## Package rules

- A domain has one package unless independently versioned distribution is a real requirement.
- Internal slices use package subpaths instead of new packages.
- Stable contracts point inward; deployment and product composition point outward.
- Core contains domain-neutral primitives and does not depend on Kernel.
- Kernel contracts do not depend on runtime, client, serve, or concrete capabilities.
- Capabilities expose host-injected ports and do not reach into a product shell.
- Public APIs fail explicitly at permission, protocol, persistence, and execution boundaries.
- Retired public APIs are removed through a documented migration; aliases are not added by default.

The root `velaros.domainPackages` map is the package identity source of truth and is validated by repository gates.

## Kernel and hosts

Kernel is library-first. A product may compose it in-process or use an optional host process. These deployment forms share contracts, not product databases or UI.

The stable dependency direction is:

```text
contracts -> runtime -> client or serve -> product adapter
```

`client` does not import `runtime` or `serve`; `contracts` does not import implementation code; update and deployment code remains isolated from the in-process runtime.

## Task and execution authority

[The shared-task ScriptAct runtime](platform-runtime.md) owns the main execution path. Context owns task state and immutable evidence; Kernel owns operation contracts, invocation and receipts; Velaros owns capability implementations and assembly; Agent owns the loop and durable run control; Model owns ProviderRequestCompiler and sending. Search and maintenance use bounded sessions with role-specific capability projections. Product hosts supply native resources and space policy.

## Memory

Long-term memory is a Markdown store scoped by the host, implemented by `packages/velaros/memory`. The host binds a scope through `createRuntime({ memory: sessionId => scope, ... })`; the main model uses `memory.recall/save/remove` from `velaros:system`. Working notes, input recall and result retention use the same system member, backed by ContextStorage. Shared structured objects and durable messages use `system.store`. See [system space](act-system-space.md) and [storage](storage.md).

## Mods and UI

Kernel owns the versioned Mod envelope and Kernel module loading. `module` is validated by Kernel; `agent` and `ui` are optional opaque sections requiring a domain or host owner. Act capabilities are explicitly supplied as OperationModuleDefinition instances through Runtime options. See [Mod integration](../mod-dev/README.md).

Products own installation UX, UI extension contracts and native shell integration. VelarOS UI owns shared presentation components.

## Changing a boundary

Changes to ownership, public protocols, permission or trust models, persisted data, compatibility generations, or package topology require an architecture decision record. The record must include motivation, alternatives, security impact, migration, validation, and rollback or clean-break consequences.
