# `@velaros-ai/kernel-serve/updater`


Installs, activates, and rolls back the shared VelarOS Kernel runtime on a
user's machine.

The updater:

- enumerates installed versions and reports which one the active pointer names;
- parses and validates an update manifest from a URL or a local file;
- selects the artifact matching a platform and CPU architecture;
- streams downloads through an injectable transport and verifies size and
  SHA-256 before anything is staged;
- invokes a pluggable signature verifier after digest verification;
- installs side by side into `versions/<version>/` through an atomic rename;
- switches `current.json` atomically and keeps the rollback target in it;
- serialises concurrent updaters behind a pid-aware exclusive file lock;
- reverts the pointer when a caller-supplied health check rejects a new
  version; and
- prunes old installs without ever removing the active or rollback version.

It owns bytes on disk and one pointer. It never invokes a capability, never
starts or stops a Kernel process, and knows nothing about product UI.

```ts
import { KernelUpdater } from '@velaros-ai/kernel-serve/updater'

const updater = new KernelUpdater({
  manifestSource: 'https://updates.example.com/kernel.json',
})

const outcome = await updater.ensureCompatible({
  range: '^1.2.0',
  healthCheck: async ({ version }) => probeKernel(version),
})
console.log(outcome.version, outcome.pointer.previousVersion)
```

## On-disk layout

```
kernel/
├── versions/
│   ├── 1.0.0/
│   │   └── .kernel-install.json
│   └── 1.1.0/
├── current.json
├── runtime/
├── data/
├── backups/
├── .staging/
└── update.lock
```

`versions/<version>/.kernel-install.json` is written inside the staging
directory before the rename, so its presence proves the install completed.
Anything left in `.staging/` belongs to a crashed run and is discarded by the
next update that holds the lock.

## Archive formats and signatures

The default extractor treats an artifact as one opaque payload file, and the
default signature verifier reports every artifact as unverified. Deployments
shipping `tar.gz`, `tar.zst`, or `zip` artifacts inject a
`KernelArtifactExtractor`; deployments with a trust root inject a
`KernelArtifactSignatureVerifier` and set `requireSignature`.
