# Product Agent surfaces

A domain product such as Fiction, Research, Finance or a Browser workspace should not fork the
Agent runtime. It should assemble Platform capabilities behind a small product-surface contract and
let each host provide the native shell adapter.

The public contract is exported from `@velaros-ai/agent/protocol`:

```ts
interface AgentProductSurfaceDefinition {
  readonly id: AgentSurfaceId
  readonly defaultSkillIds: readonly string[]
}

interface AgentSurfaceContextSnapshot {
  readonly revision: string
  readonly entries: readonly AgentSurfaceContextEntry[]
}
```

`mergeAgentSurfaceSkillSelection(...)` supplies one stable merge rule across hosts.
`serializeAgentSurfaceContextSnapshot(...)` turns a snapshot into a bounded data envelope. The
envelope is not a prompt-policy channel and cannot grant tools, permissions or workflow authority.

## Ownership and dependency direction

| Layer | Owns | Must not own |
| --- | --- | --- |
| Platform Kernel | module lifecycle, capability dependencies, permissions, module-private state namespace | product UI, Desktop database paths, domain schema |
| Platform Agent | Mod axes, Skill selection, workflow runtime, product-surface and context protocols | Electron integration, product routes, private product prompts |
| Platform Memory | semantic-memory backend ports, recall/capture/governance contracts | arbitrary Mod key-value state, host account policy |
| Product host | persistence root, native process adapters, user policy, session/model composition, UI placement | a second Agent or Workflow protocol |
| Domain Mod | domain truth model, capability implementation, Skills and workflow recipes, surface snapshot producer | raw SQL, arbitrary host services, another Mod namespace |

The stable dependency direction is:

```text
Platform contracts <- host adapters <- product composition <- domain Mod
```

A product repository may consume published Platform APIs. Platform and a general product host must
never import a private Lab or domain product repository.

## Which persistence surface to use

| Data | Platform surface | Reason |
| --- | --- | --- |
| authoritative domain project, preferences, cursors, cache metadata | `KernelModuleActivateContext.state` | private namespace, simple JSON verbs, lifecycle-bound owner |
| durable semantic memory and recall evidence | a registered Platform memory backend capability | retention, provenance, governance and erasure are memory semantics |
| chat/session transcript | host Agent session store | the host owns user session policy and presentation |
| large binary artifact | an explicit artifact/file capability | private state is bounded JSON, not a filesystem escape hatch |

Kernel state is deliberately narrow: `get`, `set`, `delete`, `list`. The Kernel binds the namespace
to the active module identity. A host chooses physical storage and may use a database per namespace,
but a Mod never receives a path, SQL handle or caller-controlled namespace.

Do not put domain truth into the global user-memory tree merely because both need persistence.
Memory is a semantic capability; private state is a module ownership boundary.

## Skills and workflows

A product surface lists default capability Skills. This is selection, not authority:

- the host still filters disabled Skills, scopes, entitlements and pure-chat mode;
- a Skill may describe a workflow recipe and call the existing bounded Agent Workflow capability;
- workflow steps still pass normal tool policy, sub-Agent limits, cancellation, confirmation and
  execution budgets;
- a Mod must not invent a second workflow registry or smuggle executable workflow code inside the
  surface snapshot.

Use the existing workflow runtime for bounded `direct`, `sequential` and `parallel` composition.
Only add a new Platform workflow primitive when several products need the same host-neutral semantic
and it can be validated, budgeted and cancelled consistently.

## Context snapshots

The domain Mod produces a revisioned snapshot from its own domain kernel. The host freezes that
snapshot with the queued turn so a later project edit cannot silently change an already queued
request. The serialized envelope has entry-count, field and total-character budgets.

Treat snapshot entries as evidence-bearing data:

- include stable entry ids and a human-readable label;
- include a source when the domain can explain provenance;
- exclude unconfirmed facts unless the label and domain schema explicitly preserve that status;
- never include secrets or data the current Agent turn is not authorized to read.

## How to extend the Platform without one-off hooks

Choose the narrowest existing surface first:

1. indexed/described capability: an existing Mod contribution axis;
2. runtime behavior change at a stable lifecycle point: a closed Hook event;
3. host effect: a permissioned Kernel capability with explicit operations;
4. private product state: Kernel module state;
5. semantic recall: Memory backend capability;
6. product Agent assembly: `AgentProductSurfaceDefinition` plus selected Skills and a context snapshot;
7. shell placement: the host's declared UI contribution contract.

A new generic Hook or contribution axis is justified only when multiple products need the same
semantic, the owner is clear, and unsupported hosts can report partial activation truthfully. Never
add a Fiction-only or Desktop-only event to the Platform vocabulary.

## Host conformance checklist

A host claiming support for product Agent surfaces should verify:

- product defaults do not survive pure-chat mode or bypass Skill availability;
- snapshots are frozen with direct, queued, continued and handed-off turns;
- the visible user message does not contain the hidden data envelope;
- owner-bound capability and settings ports do not accept a caller-supplied Mod id;
- module state namespaces are physically or cryptographically isolated by host policy;
- activation, permission, timeout and audit checks still run for every capability call;
- unsupported Mod axes remain absent/partial rather than being advertised without a consumer.
