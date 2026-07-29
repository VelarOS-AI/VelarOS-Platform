# JS/TS plugin

`@velaros-ai/workspace` includes a JS/TS plugin that can be installed into the workspace kernel without changing Core.

```ts
import { createWorkspace, typescriptPlugin } from "@velaros-ai/workspace"

const workspace = await createWorkspace({
  root: process.cwd(),
  plugins: [typescriptPlugin()],
})
```

## Capabilities

The plugin registers:

- a JS/TS AST adapter;
- a JS/TS symbol patch strategy;
- a syntax validator.

It supports:

- `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`;
- symbol listing;
- symbol search;
- function, method, class, interface, type, variable and import resolution;
- `replace_symbol`;
- `insert_around_symbol`;
- `add_import`;
- `remove_import`;
- syntax validation.

## Symbol replacement

```ts
const target = await workspace.resolveTarget({
  path: "src/auth.ts",
  target: {
    symbol: {
      kind: "method",
      container: "AuthService",
      name: "refreshToken",
    },
  },
  expectedMatches: 1,
})

if (target.status !== "resolved") throw new Error(target.reason)

const tx = await workspace.prepareEdit({
  operations: [
    {
      targetId: target.target.targetId,
      operation: {
        type: "replace_symbol",
        replacement: `refreshToken(token: string) {
  if (!token) return ""
  return verify(token)
}`,
      },
    },
  ],
})
```

## Import insertion

```ts
await workspace.prepareEdit({
  operations: [
    {
      operation: {
        type: "add_import",
        path: "src/auth.ts",
        module: "./jwt",
        named: ["verify"],
      },
    },
  ],
})
```

## Validation

```ts
await workspace.validate({
  paths: ["src/auth.ts"],
  checks: ["typescript.syntax"],
})
```

For project-level checks, install the validation plugin:

```ts
validationPlugin({ eslint: true, tsc: true })
```
