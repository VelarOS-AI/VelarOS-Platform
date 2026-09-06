# Changelog

## Unreleased

## 0.1.1 — 2026-09-06

- Add `RealTaskRecord`, deterministic outcome/health auditing, privacy-safe reports, and atomic real-task bundles.
- Add reviewed `RealTaskCase` promotion contracts for explicit single-case replay.
- Distinguish sequential feedback retries from redundant parallel failure fan-out.
- Extend the CLI with `validate real-task|case` and `audit-record`.

## 0.1.0

- Establish the public continuous-journey protocol, runner, driver contract, detector catalog,
  additive archive reader, deterministic report renderer, paired statistics, certification policy,
  and CLI.
- Historical compatibility exception: tool-call projections are deduplicated by `toolCallId` before
  per-leg accounting. Older Agent Lab reports could count cumulative projections repeatedly, including
  a known 1106-versus-69 inflation. Historical files remain untouched; new reports declare the corrected
  `unique-tool-call` measurement basis.
