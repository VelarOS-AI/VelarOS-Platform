# @velaros-ai/model

中文接口文档：[`docs/api.zh-CN.md`](docs/api.zh-CN.md)

Independently released model resolution and provider integration for VelarOS.

This package uses only generic Core utilities and Kernel SDK contracts plus
external model SDKs. It does not depend on Agent execution, Workspace,
Computer, System, Office, Browser, Memory, or Desktop implementations.

## Responsibility

`@velaros-ai/model` owns provider ids and manifests, model catalogs,
auth and explicitly injected environment resolution, OpenRouter routing,
context-window metadata, provider adapters, provider-script contracts, runtime model resolution,
request options, embedding-model selection, provider runtime availability, and
the backend auxiliary model request service.

## Public Imports

- `@velaros-ai/model/contracts` — type-only public contracts with an
  empty JavaScript module.
- `@velaros-ai/model/catalog` — pure provider catalogs, manifests, and
  explicitly injected local-model environment resolution.
- `@velaros-ai/model` — portable/browser-safe contracts and runtime APIs.
- `@velaros-ai/model/node` — Node host composition, VM adapters, and
  filesystem-backed provider-script registry, including the only default
  `process.env` adapter.
- `@velaros-ai/model/provider-scripts/node` — narrow Node provider-script
  loader entry for hosts that assemble their own composition.
- `@velaros-ai/model/ProviderScriptContextWindow` — stable portable
  context-window helper.

## Boundary

This package must not own chat UI, Desktop config persistence, IPC, or tool
registration. The host creates one isolated `ModelRuntimeComposition` and
injects its opaque Agent-facing runtime. Mutable provider-script state is owned
by that composition's explicit `ModelProviderCollection`; it is never read from
a process-global fallback. Generic model calls use `ModelRequestClient`;
`ModelRequestService` remains deprecated only for the existing product-specific
methods that will move to their owning packages. AI SDK transport details stay
in `AiSdkModelRequestTransport`.

Embedding selection and provider availability helpers always receive the
composition's `ModelProviderCollection` explicitly. Built-in catalogs remain
immutable module data, while injected provider scripts are visible only inside
the composition that registered them.

The portable root and `/catalog` entries never read `process.env`. A browser,
worker, test, or remote host creates `LocalModelEnvironment` with only the
values it intends to expose, or supplies a `ModelEnvironmentPort`. Node's
default composition performs the Node-specific environment wiring behind the
`/node` entry.

## Example

```ts
import {
  createModelKernelModule,
} from '@velaros-ai/model'
import { createModelRuntimeComposition } from '@velaros-ai/model/node'

const models = createModelRuntimeComposition()
const modelModule = createModelKernelModule({
  registry: models.modelAdapterRegistry,
})

await models.agentModelRuntime.resolveRoleRuntime(
  {
    provider: 'openai',
    model: 'gpt-5.5',
    apiKey: process.env.OPENAI_API_KEY ?? '',
    baseURL: '',
  },
  {
    providerRuntimeConfigs: [
      {
        provider: 'openai',
        enabled: true,
        apiKey: '',
        baseURL: '',
        defaultModel: 'gpt-5.5',
      },
    ],
    openRouter: { useFreeModelsForDebug: false },
  },
)
```
