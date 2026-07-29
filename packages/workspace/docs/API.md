# API Reference

## `createWorkspace(options)`

```ts
const workspace = await createWorkspace({
  root: process.cwd(),
  corePolicy: {},
  providers: {},
  plugins: [],
})
```

## Workspace methods

```ts
observe(input?)
read(input)
search(input)
listSymbols(path)
resolveTarget(input)
createTaskContext(input)
buildEvidencePack(input)
prepareEdit(input)
applyEdit(input)
validate(input)
rollback(input)
diff(input?)
status()
getJournal()
runBatch(input)
```

## Providers

Providers are external integrations consumed by the kernel.

```ts
PolicyProvider
ApprovalProvider
FileFilterProvider
SecretRedactionProvider
ContextProvider
LoggerProvider
```

The Core consumes provider decisions but does not own the broader Velaros policy or context system.

## Built-in operation types

```text
replace_text
insert_text
insert_text_at_anchor
append_text
prepend_text
delete_text
create_file
delete_file
rename_file
replace_symbol
insert_before_symbol
insert_after_symbol
add_import
remove_import
json_patch
custom
```

## Edit concurrency fields

`FileSnapshot.revision` is the file change id used by `read`, `resolveTarget`, `prepareEdit` and `applyEdit`.

`ApplyResult` contains:

```ts
{
  status: "applied"
  transactionId: string
  changedFiles: string[]
  oldRevisions: Record<string, string>
  newRevisions: Record<string, string>
  rebasedFiles?: string[]
}
```

`rebasedFiles` is present when a queued transaction was safely replayed against a newer file snapshot. Consumers should re-read those paths before making follow-up edits.

## Replay-friendly text operations

```ts
{
  type: "insert_text_at_anchor"
  path: string
  anchorText: string
  position: "before" | "after"
  text: string
  expectedMatches?: number
  skipIfAlreadyPresent?: boolean
}

{
  type: "append_text" | "prepend_text"
  path: string
  text: string
  skipIfAlreadyPresent?: boolean
}
```

These are intended for known same-file concurrency when their anchors naturally express the edit. They are not a replacement for symbol edits or precise structured patches when the model is the only known editor.

## Built-in plugins

The default `corePlugin()` registers:

```text
TextAdapter
JsonAdapter
MarkdownAdapter
GenericCodeAdapter
TextPatchStrategy
JsonPatchStrategy
ScopeValidator
PostconditionValidator
```

Set `includeBuiltinPlugins: false` if Velaros wants to provide its own default plugin stack.
