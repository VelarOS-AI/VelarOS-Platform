# Production readiness

This package is designed as a production-oriented workspace kernel. It does not claim to solve every project-specific concern internally. Instead, it defines stable contracts for Velaros Agent OS and plugins.

## Ready now

- transaction-safe file edits;
- base revision checks;
- target IDs;
- audit journal;
- rollback;
- batch DAG execution;
- conflict detection for declared resources;
- provider boundary;
- adapter/patch/validator/plugin registries;
- JS/TS symbol location and patching;
- command validation plugin;
- Velaros bridge;
- MCP-like adapter;
- CLI and tests.

## Must be supplied by Velaros or deployment runtime

- organization-specific policy;
- approval UX;
- sandbox/worktree lifecycle;
- command execution isolation;
- context ranking and memory;
- telemetry sink;
- native Tree-sitter parser lifecycle;
- LSP server lifecycle;
- production secret management.

## Recommended deployment defaults

1. Use `createVelarosWorkspaceBridge` instead of directly calling `createWorkspace` inside Velaros.
2. Provide `policy`, `approval`, `fileFilter`, `secretRedaction`, `command`, `telemetry` and optional `sandbox` providers.
3. Use `prepare_edit` before `apply_edit` and require diff review for medium/high-risk transactions.
4. Do not expose raw file write tools to agents.
5. Run syntax validation for every code transaction.
6. Run project validators for package-level changes.
7. Use batch `atomic: true` for multi-file agent plans.
8. Keep Tree-sitter and LSP engines as plugins/providers.
