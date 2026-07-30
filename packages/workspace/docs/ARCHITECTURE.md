# Architecture

```text
Velaros Agent OS
  ├─ Context / Memory / Planner / Policy / UI
  │
  └─ @velaros-ai/workspace
       ├─ Workspace kernel
       ├─ File store
       ├─ Adapter registry
       ├─ Patch strategy registry
       ├─ Validator registry
       ├─ Hook registry
       ├─ Pipeline registry
       ├─ Transaction manager
       ├─ Lock manager
       ├─ Batch runner
       └─ Audit journal
```

## Runtime flow

```text
read/search
  -> resolve target
  -> build evidence pack
  -> prepare edit
  -> apply edit
  -> validate
  -> rollback or continue
```

## Built-in plugin

`corePlugin()` registers starter capabilities:

- `textAdapterFactory()`
- `jsonAdapterFactory()`
- `markdownAdapterFactory()`
- `codeAdapterFactory()`
- `textPatchStrategy()`
- `jsonPatchStrategy()`
- `scopeValidator()`
- `postconditionValidator()`

## Extension points

### Providers

Providers are outside the kernel and are normally owned by Velaros OS:

- `PolicyProvider`
- `ApprovalProvider`
- `FileFilterProvider`
- `SecretRedactionProvider`
- `ContextProvider`
- `LoggerProvider`

### Plugins

Plugins register adapters, patch strategies, validators, hooks and pipeline stages.

### Adapters

Adapters understand file types: text, code, structured data, documents, spreadsheets, presentations, PDFs, images and binaries.

### Patch strategies

Strategies convert edit intents into prepared patches.

### Validators

Validators verify scope, postconditions, syntax, type checks, tests, document integrity or business-specific constraints.

## Why this architecture

The kernel keeps strong invariants while allowing external intelligence to improve over time. You can start with text fallback and later add Tree-sitter, LSP, DOCX, XLSX or PDF plugins without changing the agent contract.
