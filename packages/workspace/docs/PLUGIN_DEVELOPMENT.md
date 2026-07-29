# Plugin Development

Plugins extend the kernel through registration:

```ts
const plugin = {
  name: "my-plugin",
  version: "0.1.0",
  setup(ctx) {
    ctx.registerAdapterFactory(factory)
    ctx.registerPatchStrategy(strategy)
    ctx.registerValidator(validator)
    ctx.registerHook(hook)
    ctx.registerPipelineStage(stage)
  },
}
```

Adapters understand files. Patch strategies compile edit intents into prepared patches. Validators verify results. Hooks observe lifecycle events. Pipeline stages transform inputs.

Plugins should preserve core invariants: no direct mutation during prepare, preserve revision checks, return structured diagnostics and keep failures explicit.
