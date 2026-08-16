# Memory backend architecture

This document is the public implementation guide for memory storage in VelarOS Platform. It describes the current package contracts; product-specific host wiring belongs in the consuming application.

## Status

The package provides three composable storage roles:

- `memory-tree` is the current default authority when a host supplies `MemoryDomain`.
- `memory-files` is a file-backed authority with human-readable Markdown records.
- `memory-vector` is an optional derived index. It accelerates recall but never owns memory content.

`mountMemoryAdapter()` still requires a `MemoryDomain` and falls back to the tree authority when the host does not select another registered backend. A files-only host therefore still needs the tree domain for lifecycle services. Removing that requirement is an open implementation task and must preserve the adapter lifecycle contract.

## Invariants

1. Exactly one authority owns the durable content and stable item identifiers.
2. Derived indexes contain pointers and vectors, not authoritative text.
3. Authority writes complete before derived indexing starts.
4. A derived-index failure is diagnostic; it cannot roll back a successful authority write.
5. Recall results from a derived index are resolved through the authority. Orphaned pointers are discarded and pruned.
6. Archiving removes an item from ordinary recall but is not physical erasure.
7. Backend paths, file I/O, embedding services, and host configuration are injected. The package does not assume a Desktop directory layout.

## Backend contract

The implementation-neutral contract lives in `packages/memory/src/backend/Contract.ts`.

An authority backend must provide:

- `capture` and `captureBatch`;
- `recall` and `getItem`;
- `inspect`;
- `archive`.

The optional `dream` and `govern` verbs are capability extensions. A backend must advertise only the verbs it implements.

Backend registration uses the capability token family:

```text
velaros.memory.store.<backendId>
```

`resolveMemoryStoreBackend()` accepts only backends with role `authority`. Derived indexes use the separate `resolveMemoryDerivedIndexBackends()` path so they cannot be selected accidentally as durable storage.

## File authority

Public entry point: `@velaros-ai/memory/files`.

```ts
const files = createMemoryFilesBackend({
  roots: () => [
    {
      scopeType: 'workspace',
      scopeId: 'project:/workspace/example',
      directory: '/workspace/example/.velaros/memory',
    },
  ],
  io: createNodeMemoryFilesIo(),
})
```

Each scope root has the following layout:

```text
<root>/
  MEMORY.md
  entries/
    <slug>.md
```

`MEMORY.md` is the searchable index. Each entry is Markdown with frontmatter. The parser accepts BOM and CRLF input, common frontmatter aliases, unknown fields, and incomplete fences without destroying user-authored content. Writes preserve unknown metadata.

The backend supports dynamic roots and read-only roots. Paths are provided by the host, so a headless service and a desktop application can use different storage layouts without changing the package.

## Vector derived index

Public entry point: `@velaros-ai/memory/vector`.

```ts
const vector = createMemoryVectorBackend({
  embedder,
  store: createFileVectorIndexStore({ io, directory }),
})
```

The embedder identity includes provider, model, and vector dimensions. That identity is part of the index version; changing it marks the index stale and requires a rebuild from the authority.

The default persistent index stores normalized `Float32` vectors in an injected text I/O implementation. This is appropriate for personal-memory collections and avoids making a native vector database part of the default installation. `MemoryVectorIndexStore` remains replaceable if a host needs another implementation.

## Layered composition

`createLayeredMemoryStoreBackend()` combines one authority with zero or more derived indexes:

```ts
const store = createLayeredMemoryStoreBackend({
  authority: files,
  derived: [vector],
  onDerivedFailure: (failure) => diagnostics.record(failure),
})
```

Capture writes to the authority first and passes the resulting records to the derived indexes. Recall runs authority and derived lookups in parallel, resolves derived pointers through `authority.getItem()`, removes orphans, and interleaves the result sets. It does not compare lexical and vector scores as if they shared a scale.

The layered store retains the authority descriptor. Adding or removing a derived index changes performance and diagnostics, not the identity of the memory store.

## Host integration

A host that selects non-default backends is responsible for:

1. constructing scope roots and an I/O implementation;
2. registering authority and derived backends with the Kernel module host;
3. passing the authority preference to `mountMemoryAdapter()`;
4. composing derived indexes around the resolved authority;
5. providing an embedder when vector recall is enabled;
6. exposing backend health and stale-index state in its diagnostics surface;
7. migrating existing authority data before changing the default backend.

Changing authority is a data migration, not a configuration toggle. The host must prove parity, preserve stable scope semantics, and retain a recoverable rollback point before switching writes.

## Verification

The maintained gates are:

- `bun run check:memory-boundaries` for package direction rules;
- `bun run probe:memory` for file authority, vector indexing, layered composition, and capability resolution;
- `bun run test:memory` for maintained integration tests.

Contract, implementation, tests, and this document must change together.
