# Platform 0.6.14 migration

Platform 0.6.14 publishes the stable Agent host/runtime boundary, typed Model structured output,
and a package compatibility fix required by Agent patch upgrades.

## Package versions

| Package | Version | Scope |
| --- | --- | --- |
| `@velaros-ai/agent` | `0.6.10` | Stable `runtime` and `host` subpaths, API baseline, and cancellation correctness. |
| `@velaros-ai/model` | `0.6.0` | Schema-derived structured output and explicit decoded output. |
| `@velaros-ai/development` | `1.1.1` | Language reads no longer load the Project Agent runtime barrel. |
| `@velaros-ai/browser` | `0.2.17` | Agent peer compatibility range. |
| `@velaros-ai/computer` | `0.2.12` | Agent peer compatibility range. |
| `@velaros-ai/memory` | `0.4.1` | Agent peer compatibility range. |
| `@velaros-ai/office` | `1.1.6` | Agent peer compatibility range. |
| `@velaros-ai/project` | `2.0.9` | Agent peer compatibility range. |
| `@velaros-ai/system` | `1.1.6` | Agent peer compatibility range. |

The capability packages now publish `^0.6.10` as their Agent peer range. A consumer can therefore
take compatible Agent patch releases without resolving a false peer conflict. Runtime dependencies
remain exact, so a package still runs against the first-party versions used to build its release.

## Agent imports

Existing imports from `@velaros-ai/agent` continue to work. New host integration should import the
execution assembly surface from `@velaros-ai/agent/runtime` and injected host ports from
`@velaros-ai/agent/host`:

```ts
import { createAgentExecutionStack } from '@velaros-ai/agent/runtime'
import type { AgentRuntimeCapabilityPorts } from '@velaros-ai/agent/host'
```

The root aliases listed in `packages/agent/docs/public-api-policy.json` remain available through
Agent 0.x and carry deprecation declarations. `check:agent-public-api` protects every exported
entrypoint and declaration against an unversioned breaking change.

## Model structured output

`generateObject` now derives its result from the supplied AI SDK `FlexibleSchema`. Remove explicit
generic arguments that previously overrode the schema result. A same-type normalizer can keep using
`mapOutput`; code that converts the schema result into another domain type must use
`generateDecodedObject`:

```ts
const rule = await client.generateObject({
  endpoint: 'scheduler.rule',
  model,
  system,
  messages,
  schema: scheduleRuleSchema,
  schemaName: 'ScheduleRule',
  schemaDescription: 'One validated schedule rule.',
})

const ruleId = await client.generateDecodedObject({
  endpoint: 'scheduler.rule-id',
  model,
  system,
  messages,
  schema: scheduleRuleSchema,
  schemaName: 'ScheduleRule',
  schemaDescription: 'One validated schedule rule.',
  decodeOutput: (output) => output.id,
})
```

Model `0.6.0` is a minor release because changing the former unconstrained generic contract is
breaking under the package's 0.x version policy.

## Consumer update

Update all Platform packages in a product together, regenerate `bun.lock`, then run a frozen install
and the product's maintained check. This release train is identified by Git tag `v0.6.14`; package
manifests use the individual versions in the table above.
