# Platform boundaries

## Product position

VelarOS is a personal AI operating system and an ecosystem of AI applications. VelarOS Kernel is the common foundation that lets those applications reuse execution, capabilities, memory, permissions, context, state, and APIs.

VelarOS Desktop is the first shipping product, desktop shell, validation product, and reference integration. Desktop is important, but its current workspaces and UX do not define the final scope of VelarOS or the Platform.

## Ownership

| Owner | Responsibilities |
| --- | --- |
| VelarOS Platform | Kernel contracts and runtime, Agent runtime, model adapters, reusable capabilities, memory, host-neutral UI, surface protocols, evaluation, and reusable host processes |
| Product hosts | Native process integration, product composition, user-facing policy, account/session adapters, packaging, and product-specific persistence roots |
| Cloud services | Accounts, entitlements, organization policy, remote service state, and service-side enforcement |
| Mods | Declared contributions behind the versioned mod envelope and the permissions granted by a host |

Product hosts depend on Platform packages through published APIs. Platform packages do not import product source code, private product prompts, host UI, product configuration files, or product-only persistence.

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

## Memory

Memory backends implement explicit ports and are selected through host composition. Evidence ownership, recall, Dream scheduling, retention, erasure, and credential access cannot be inferred from a product shell. The canonical memory-tree format and hashing rules live in the Platform memory specifications and probes.

## Mods and UI

The public mod envelope, trust model, contribution axes, lifecycle, and diagnostics are owned by `docs/mod-dev/` and the corresponding schemas in Platform packages.

Products own their installation experience and native shell adapters. A Platform UI contribution is a declared host-neutral contract; it must not embed a Desktop-only component, route, account flow, or prompt.

## Changing a boundary

Changes to ownership, public protocols, permission or trust models, persisted data, compatibility generations, or package topology require an architecture decision record. The record must include motivation, alternatives, security impact, migration, validation, and rollback or clean-break consequences.
