# @velaros-ai/surface-protocol

Versioned, host-neutral wire contracts for provider-owned VelarOS Agent
Surfaces. The package carries no Desktop, Electron, Kernel runtime, storage, or
transport implementation.

Transport remains a separate concern: the Chrome extension currently carries
these payloads over External Agent Bridge v2, while future Web and mobile
clients can use another authenticated gateway without changing tool contracts.

Tool results may carry a small, bounded list of validated PNG/JPEG artifacts.
Binary data stays outside textual tool output so provider adapters can upload it
through their native attachment path without leaking base64 into model context.
