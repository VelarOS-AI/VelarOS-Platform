# `@velaros-ai/kernel-sdk`

中文接口文档：[docs/api.zh-CN.md](docs/api.zh-CN.md)

Product-neutral contracts for modules injected into the VelarOS microkernel.

The SDK contains no concrete capability implementation. A module declares what
it provides and requires in a `KernelModuleManifest`, then receives only the
scoped service and event APIs exposed through `KernelModuleActivateContext`.

```ts
import {
  createCapabilityToken,
  defineKernelModule,
} from '@velaros-ai/kernel-sdk'

interface Clock {
  now(): number
}

const ClockCapability = createCapabilityToken<Clock>('example.clock')

export default defineKernelModule({
  manifest: {
    id: 'example.clock.local',
    version: '1.0.0',
    apiVersion: 1,
    provides: [ClockCapability],
    requires: [],
    optionalRequires: [],
    permissions: [],
    isolation: 'in-process',
  },
  activate(context) {
    context.registerService(ClockCapability, { now: () => Date.now() })
  },
})
```

## Callable capabilities

Capabilities exposed through a Kernel service use
`createKernelCallableCapability`. Each closed operation declares only the
permissions required for that operation; unknown operations return no metadata
and are rejected before invocation.

```ts
const files = createKernelCallableCapability({
  read: {
    metadata: {
      permissions: ['fs:read'],
      reason: 'Read a scoped file.',
    },
    invoke: (_scope, input) => readValidatedInput(input),
  },
})
```

Input schemas and product-domain operation names remain in the capability
package. The SDK only defines the product-neutral call and permission metadata
contract.
