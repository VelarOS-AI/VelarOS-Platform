# Plugin Authoring

Plugins extend the workspace kernel without changing Core.

## Plugin shape

```ts
import type { WorkspacePlugin } from "@velaros-ai/workspace"

export function myPlugin(): WorkspacePlugin {
  return {
    name: "my-plugin",
    version: "1.0.0",
    setup(ctx) {
      ctx.registerAdapterFactory(myAdapterFactory())
      ctx.registerPatchStrategy(myPatchStrategy())
      ctx.registerValidator(myValidator())
      ctx.registerHook(myHook())
      ctx.registerPipelineStage(myStage())
    },
  }
}
```

## Adapter factory

Adapters are selected per file snapshot.

```ts
const factory = {
  id: "example.adapter.factory",
  canHandle(snapshot) {
    return snapshot.path.endsWith(".example")
  },
  create({ snapshot, kernel }) {
    return {
      id: "example.adapter",
      kind: "text",
      priority: 100,
      capabilities: ["resolve", "validate"],
      resolveTarget(input) {
        // return resolved / ambiguous / not_found
      },
      validate(input) {
        return { ok: true, diagnostics: [], checks: [] }
      },
    }
  },
}
```

## Patch strategy

Patch strategies compile `EditIntent` to `PreparedPatch`.

```ts
const strategy = {
  id: "example.patch",
  priority: 100,
  canHandle(input) {
    return input.intent.operation.type === "custom"
  },
  prepare(input) {
    return []
  },
}
```

## Validators

Validators run after apply, or on selected paths.

```ts
const validator = {
  id: "example.validator",
  canValidate(input) {
    return true
  },
  validate(input, ctx) {
    return { ok: true, diagnostics: [], checks: [{ id: "example.validator", ok: true }] }
  },
}
```

## Hooks and pipeline stages

Hooks are for lifecycle side effects. Pipeline stages can transform inputs before core handling.

Use hooks for deterministic tasks such as audit, formatting, or index refresh. Use adapters and strategies for file-specific logic.
