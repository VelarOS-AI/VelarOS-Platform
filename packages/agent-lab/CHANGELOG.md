# Changelog

## 0.1.0

- Establish the public continuous-journey protocol, runner, driver contract, detector catalog,
  additive archive reader, deterministic report renderer, paired statistics, certification policy,
  and CLI.
- Historical compatibility exception: tool-call projections are deduplicated by `toolCallId` before
  per-leg accounting. Older Agent Lab reports could count cumulative projections repeatedly, including
  a known 1106-versus-69 inflation. Historical files remain untouched; new reports declare the corrected
  `unique-tool-call` measurement basis.
