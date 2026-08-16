# Contributing to VelarOS Platform

Thank you for helping build VelarOS Platform. This repository contains shared infrastructure used by multiple VelarOS products, so changes must preserve package ownership, host neutrality, and security boundaries.

## Before you start

1. Search existing issues and pull requests.
2. Open an issue before large API, protocol, storage, permission, security, or package-boundary changes.
3. Keep each pull request focused on one coherent change.
4. Never include credentials, private service details, personal filesystem paths, customer data, or material copied from a source whose license is unclear.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md), not the public issue tracker.

## Development setup

VelarOS Platform uses Bun 1.3.13 and Node.js 20 or newer.

```bash
bun install --frozen-lockfile
bun run check
```

Use narrower package or domain checks while iterating, but run `bun run check` before requesting review. If an unrelated baseline failure blocks the full gate, identify it explicitly and include evidence for the checks covering your changed chain.

## Engineering expectations

- Put behavior in its owning package; product shells provide adapters and composition.
- Keep public APIs host-neutral unless the package explicitly owns a host integration.
- Prefer explicit failure over silent fallback at protocol, permission, persistence, and execution boundaries.
- Document public API behavior, compatibility impact, security consequences, and migration requirements.
- Comments explain intent, invariants, or non-obvious trade-offs. Remove temporary walkthrough notes and stale implementation plans.
- Generated files must be reproducible and must not contain machine-specific paths or environment data.
- Add or update tests for behavior changes. Type-checking alone is not runtime proof.
- Do not add compatibility aliases for retired APIs unless an approved migration requires them.

## Commits and pull requests

Write commit subjects in the imperative mood and describe the engineering outcome. Avoid private ticket numbers, batch labels, conversational notes, or claims that exceed the validation performed.

A pull request must include:

- the problem and ownership boundary;
- the chosen design and important alternatives;
- compatibility, security, and release impact;
- tests and commands run;
- remaining risks or follow-up work.

By contributing, you agree that your contribution is submitted under the repository's [Apache License 2.0](LICENSE) and that you have the right to submit it.
