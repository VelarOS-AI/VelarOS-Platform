# Engineering standard

## Non-negotiable rules

1. Put behavior in its real owner. Product adapters do not become a second implementation source.
2. Fail explicitly at security, permission, protocol, persistence, and execution boundaries.
3. A change is complete only when its contract, implementation, tests, documentation, and distribution shape agree.

## Public-source hygiene

- Never commit credentials, customer data, internal-only endpoints, personal paths, private prompts, or unpublished product configuration.
- Use examples such as `/Users/example`, `/home/example`, `C:\\Users\\example`, `example.com`, and reserved `.test` or `.invalid` domains.
- Generated artifacts must be deterministic and free of local paths, timestamps, machine identities, and environment-dependent type names.
- Third-party code requires pinned provenance, complete license text, attribution, and a reproducible update procedure.
- Public documentation must be understandable without access to another private repository.

## APIs and compatibility

- Export the smallest stable surface and keep implementation details internal.
- Validate untrusted data at the boundary; do not spread partially validated objects.
- Use semantic versioning for packages and `velaros.platform` for cross-package compatibility generations.
- Document breaking changes and migrations before releasing them.
- Remove retired APIs after an approved clean break; do not accumulate aliases by default.

## Errors and observability

- Do not swallow exceptions. Handle, report, convert to an explicit error result, or rethrow with context.
- Preserve causal information without leaking secrets or private user content.
- Use domain logging instead of direct console output in runtime code.
- Timeouts, cancellation, and cleanup are part of the API contract for external processes and remote calls.

## Comments and documentation

- Comments explain intent, invariants, ownership, security reasoning, or non-obvious trade-offs.
- Do not leave batch numbers, walkthrough narration, personal reminders, or obsolete future plans in maintained code.
- Keep identifiers and public API terminology in English. Public entry documentation is English-first; accurate Chinese translations are welcome.
- Describe current behavior in the present tense and planned work as planned work.

## Tests and evidence

- Test diagnostics, emitted or serialized artifacts, and runtime behavior where applicable.
- Add negative tests for permissions, invalid input, cancellation, timeouts, and cleanup.
- Test packages from their packed artifact so ambient workspace state cannot hide missing files or dependencies.
- Separate changed-chain results from unrelated baseline failures; never call a partial gate fully green.

## Review

Review ownership, correctness, security, compatibility, test quality, documentation, and release impact. Large mechanical rewrites must be isolated from semantic changes so reviewers can verify both.
