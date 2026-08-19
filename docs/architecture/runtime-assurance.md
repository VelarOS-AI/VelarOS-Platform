# Runtime assurance and observability

VelarOS separates authority, observability, and operating-system enforcement. A diagnostic JSON object
does not grant authority, an approval does not prove confinement, and an audit fingerprint is not a
replacement for the exact request it identifies.

## Kernel composition: inspect, never patch

`Kernel.describeComposition()` and `KernelService.describeComposition()` return a deterministic,
frozen `KernelCompositionSnapshot`. It contains the resolved module order, declared manifests and
lifecycle state, and each declared capability's provider, active state, and active generation.

The snapshot is intentionally one-way. There is no inverse patch API: module registration, permissions,
activation, rollback, and service ownership continue to be decided by Ring 0. `active: false` distinguishes
a declared provider from a service that was actually registered by the current generation. The optional
serve deployment remains governed by its versioned wire protocol and handshake; this local snapshot does
not silently extend that remote protocol.

## Agent requests: reconstruct before sending

The Agent request compiler produces a keyless `ProviderRequestSnapshot` at the final provider boundary.
It records the provider-visible model alias, rewritten system text, ordered messages, exact tool descriptions
and schemas, tool choice, and the request fingerprint. The fingerprint binds the final system text, message
content, visible tool names, and schema hashes; two transcripts with the same roles but different content
therefore cannot share an identity.

Immediately before a streaming or query request is sent, the runtime verifies that every visible tool can
be reconstructed from the snapshot. A missing schema or mismatched tool surface fails closed as an invariant
error. Keyless fixture tests cover this boundary without contacting a model provider.

Prompt audit sidecars may store the exact snapshot for local debugging. They are not session authority and
must never contain provider credentials or executable clients. They can contain user and model content, so
hosts must apply their retention policy and redact them before export.

`describeRunProfiles()` exposes the built-in compact, balanced, and expanded budgets plus automatic
selection thresholds as a frozen catalog. It explains a runtime selection; it cannot override permission,
tool-execution, or Kernel policy.

## System processes: approval is not confinement

`@velaros-ai/system/execution` exposes one process-confinement contract for `read-only`,
`workspace-write`, and `danger-full-access` execution. Every new execution result should carry
`SystemProcessConfinementEvidence`, recording the requested mode, actual backend, enforcement strength,
reason, and effective writable roots.

VelarOS currently provides a Seatbelt backend on macOS and a bubblewrap backend on Linux. Hosts may inject
a stronger provider such as a Windows restricted-token or container implementation. If a confined mode is
requested and neither a built-in backend nor an injected provider is available, execution fails closed with
`SYSTEM_PROCESS_CONFINEMENT_UNAVAILABLE`; it never silently falls back to a bare process. The
`LocalSystemKernel` compatibility default is explicit `danger-full-access`, which reports
`enforcement: "none"` rather than pretending to be isolated.

File confinement does not itself grant permission to execute a command. The host still owns user approval,
scope, policy, and any extra writable roots. Conversely, an approved command is not considered confined
unless its launch result reports real enforcement evidence.
