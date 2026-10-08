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

## Model requests: compile the actual next frame

`ProviderRequestCompiler` in Model compiles the actual next request, including the five context partitions, ordered history, instructions and native image parts. It checks the complete request budget and produces an auditable provider projection. Raw accepted responses, scripts and invocation receipts remain traceable through `runtime.trace`.

Act supports native JSON tools and framed text through the same Runtime. The selected transport controls request tools, instructions and decoding; executable programs are accepted only after the complete response passes validation. Business operations are discovered through the current host catalog and module contracts. See [the actual runtime chain](platform-runtime.md) and [text protocol](scriptact-text-protocol.md).

Observability cannot alter authority. Debug snapshots and traces may contain user or model content; hosts control access, retention and export redaction. Credentials and executable clients are not trace payloads. Request fingerprints identify evidence and do not replace the underlying request or grant permission.

## System processes: approval is not confinement

`@velaros-ai/velaros/execution/local` exposes one process-confinement contract for `read-only`,
`workspace-write`, and `danger-full-access` execution. Every new execution result should carry
`ShellProcessConfinementEvidence`, recording the requested mode, actual backend, enforcement strength,
reason, and effective writable roots.

VelarOS currently provides a Seatbelt backend on macOS and a bubblewrap backend on Linux. Hosts may inject
a stronger provider such as a Windows restricted-token or container implementation. If a confined mode is
requested and neither a built-in backend nor an injected provider is available, execution fails closed with
`SHELL_CONFINEMENT_UNAVAILABLE`; it never silently falls back to a bare process. The local shell host's
(`createLocalShellHost`, `@velaros-ai/velaros/execution/local`) default for ordinary commands is explicit `danger-full-access`, which reports
`enforcement: "none"` rather than pretending to be isolated.

File confinement does not itself grant permission to execute a command. The host still owns user approval,
scope, policy, and any extra writable roots. Conversely, an approved command is not considered confined
unless its launch result reports real enforcement evidence.
