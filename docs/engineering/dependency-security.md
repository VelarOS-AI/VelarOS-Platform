# Dependency security policy

VelarOS Platform treats the lockfile, dependency overrides, and Bun patches as reviewed source. The default rule is to upgrade to a non-vulnerable version. An audit exception is allowed only when the repository also contains a narrow justification and a mechanical regression check.

## Current exceptions

### `image-size@1.2.1`

`pptxgenjs@4.0.1` declares `image-size`, while its distributed runtime does not call that dependency. The npm package nevertheless remains in the production dependency graph and all published `image-size` versions are currently covered by CVE-2025-71329 and CVE-2025-71330.

The committed Bun patch rejects undersized ICNS entries and undersized ISO BMFF boxes before an offset loop can stall. `scripts/security/checkPatchedDependencies.mjs` runs malformed ICNS, JXL, and HEIF inputs in timeout-bounded child processes. The two CVEs may remain ignored only while that patch and those probes pass. Remove the patch and both ignores when upstream publishes a fixed release accepted by `pptxgenjs`.

### `uuid@8.3.2`

`exceljs@4.4.0` constrains `uuid` to version 8. CVE-2026-41907 affects the `v3`, `v5`, and `v6` APIs when callers provide an invalid output buffer. ExcelJS has one UUID call site and invokes only `v4()` without an output buffer. The dependency probe scans the installed ExcelJS runtime and fails if that assumption changes. Remove the ignore when ExcelJS accepts `uuid >=11.1.1`.

## Maintenance rules

- Do not add an audit ignore without a matching entry in this document.
- Prefer a compatible upstream release over an override, and an override over a local patch.
- Keep patches minimal and test the exact failure mode they mitigate.
- Re-run `bun run check:dependency-security` whenever the lockfile changes.
