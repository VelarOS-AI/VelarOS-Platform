# Dependency security policy

VelarOS Platform treats the lockfile, dependency overrides, and Bun patches as reviewed source. The default rule is to upgrade to a non-vulnerable version. An audit exception is allowed only when the repository also contains a narrow justification and a mechanical regression check.

## Current exceptions

### `uuid@8.3.2`

`exceljs@4.4.0` constrains `uuid` to version 8. CVE-2026-41907 affects the `v3`, `v5`, and `v6` APIs when callers provide an invalid output buffer. ExcelJS has one UUID call site and invokes only `v4()` without an output buffer. The dependency probe scans the installed ExcelJS runtime and fails if that assumption changes. Remove the ignore when ExcelJS accepts `uuid >=11.1.1`.

## Maintenance rules

- Do not add an audit ignore without a matching entry in this document.
- Prefer a compatible upstream release over an override, and an override over a local patch.
- Keep patches minimal and test the exact failure mode they mitigate.
- Re-run `bun run check:dependency-security` whenever the lockfile changes.

## Removed vulnerable dependencies

`pptxgenjs@4.0.1` used to retain an unused `image-size` dependency whose published versions were affected by CVE-2025-71329 and CVE-2025-71330. Office now vendors the PptxGenJS 4.0.1 ESM runtime with narrow local security patches, plus the unchanged upstream declarations, MIT license, and notice. The patches use Web Crypto for UUIDs and reject media relationship paths that escape the presentation archive root. `scripts/security/checkPatchedDependencies.mjs` pins both vendored file hashes, checks the patch markers, and fails if either file references `image-size`, so the vulnerable package is absent from the production graph instead of being carried behind an audit exception.
