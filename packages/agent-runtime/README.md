# @velaros-ai/agent-runtime

中文接口文档：[docs/api.zh-CN.md](docs/api.zh-CN.md)

## Responsibility

`@velaros-ai/agent-runtime` owns host-agnostic agent execution: loop runners, prompt state, role routing, orchestration policy, execution ledgers, team planning, capability consumer ports, tool registry/executor helpers, reminders, and runtime event contracts.

## Public Imports

- `@velaros-ai/agent-runtime`

## Boundary

This package is not the Desktop app and is not a dumping ground for feature modules. It must not own memory/knowledge indexing, model provider adapters, browser implementation or policy, office tools, Workspace implementation or Workspace Agent tools, Electron transport, Desktop config, IPC, renderer UI, or app-private manifests. Hosts compose this runtime and capability-specific tool packages from their own composition root.

Concrete capabilities integrate through `AgentRuntimeCapabilityPorts`:

- `resultMiddlewares` post-process capability-owned tool results;
- `validationHintProviders` explain capability-owned schemas;
- `allocation` maps host-defined operations to categories and prerequisites;
- `promptContributors` provide capability-specific runtime guidance;
- `contextCollectors`, `intentClassifiers`, and `evidenceExtractors` keep domain interpretation in capability packages;
- `validationInterpreters` own capability-specific verification;
- `scopePolicy` owns product scope and residency semantics;
- `toolAliases` handles capability-owned compatibility names.

Agent Runtime interprets none of those domain identifiers. An absent port means absent behavior.
Agent surfaces are product-owned and injected through `AgentSurfaceProfileProvider`; the runtime
has no global surface registry or built-in fallback collection.
Primary Agent identity is host-owned: pass `primaryAgentIdentity` to
`createBuiltInPromptRegistry`. The default identity is deliberately product-neutral.
`SkillMarketClient` is disabled until the host injects `marketBase`; it has no Desktop repository
or environment-variable fallback.

## Example

```ts
import type { AgentRuntimeCapabilityPorts } from '@velaros-ai/agent-runtime'

const capabilityPorts: AgentRuntimeCapabilityPorts = {
  extensions: [
    {
      descriptor: {
        id: 'example.documents',
        operationIds: ['read-document'],
        categoryIds: ['documents'],
      },
      allocation: {
        operationCategories: {
          'read-document': ['documents'],
        },
      },
    },
  ],
}
```
