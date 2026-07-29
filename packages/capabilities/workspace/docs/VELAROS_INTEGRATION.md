# Velaros integration

`@velaros-ai/workspace` is intended to be mounted as the Workspace module of Velaros Agent OS.

```ts
import { createVelarosWorkspaceBridge, typescriptPlugin, validationPlugin } from "@velaros-ai/workspace"

const bridge = await createVelarosWorkspaceBridge({
  root: velaros.project.root,
  velaros,
  autoRegisterTools: true,
  plugins: [
    typescriptPlugin(),
    validationPlugin({ eslint: true, tsc: true }),
  ],
})
```

## Provider mapping

Velaros can provide:

```ts
{
  context,
  policy,
  approval,
  fileFilter,
  secretRedaction,
  command,
  sandbox,
  telemetry,
  logger,
}
```

Workspace consumes these providers but does not own their business logic.

## Agent call contract

Velaros agents should use this sequence:

```text
read/search
resolve_target
build_evidence
prepare_edit
apply_edit
validate
rollback if needed
```

The context system may build richer evidence packs externally, but the edit call must still reference resolved targets and current revisions.

## Module export

`createVelarosWorkspaceBridge()` returns:

```ts
{
  workspace,
  tools,
  mcp,
  registerTools,
  asModule,
}
```

Velaros can register the tools or mount the module returned by `asModule()`.
