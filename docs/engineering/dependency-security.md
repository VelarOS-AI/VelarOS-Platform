# Dependency security policy

VelarOS Platform treats the lockfile, dependency overrides, and Bun patches as reviewed source. The default rule is to upgrade to a non-vulnerable version. An audit exception is allowed only when the repository also contains a narrow justification and a mechanical regression check.

## Current security pins

The root and Velaros development manifests pin Electron to 42.11.16. This fixes the compromised eMudhra intermediate-certificate mitigation advisory [GHSA-jr5w-w6x2-84p9](https://github.com/advisories/GHSA-jr5w-w6x2-84p9), which appeared as two alerts because both manifests declared the older Electron. This changes Platform's development/test host; separately shipped products must update their own Electron distribution.

The root override table also fixes the installed dependency graph at body-parser 2.4.0, fast-uri 3.1.9, Hono 4.13.11, ip-address 10.7.5, undici 7.30.1 and Zod 4.6.6. These are fixes within the existing major versions for the advisories reported by the 2026-10-26 audit. The committed lockfile records the exact resolved packages; consumers of separately published packages must check their own graph because root overrides do not automatically propagate to another repository.

The `@hono/node-server` override is 2.1.3 for [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f). The installed 2.0.12 middleware reproduced the double-decode bypass: a malformed encoded path returned a protected fixture with status 200 while the ordinary protected path returned 401. The regression enumerates every reachable copy, verifies the malformed path returns 404, keeps both ordinary and encoded protected paths behind middleware, and checks public space/Unicode filenames remain readable. Version 2.1.3 is within the existing MCP SDK dependency range; the [upstream fix](https://github.com/honojs/node-server/commit/9821792) rejects residual percent signs before file resolution. No audit exception is added.

Run the complete security gate after a frozen install. A clean audit here includes the explicitly reviewed exceptions below; it is not a claim that an unpatched upstream version is safe in other installations.

## Current exceptions

### `braces@3.0.3` with the reviewed depth patch

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) affects deeply nested patterns in the parser and recursive AST walkers. The published 3.0.3 version has no upstream fix as of 2026-10-06. `patches/braces@3.0.3.patch` enforces a maximum group depth of 128 in parsing, compilation, expansion, and stringification, including directly supplied ASTs. Excessive nesting throws `SyntaxError`; ordinary ranges, alternatives, escaped literals, and globby's async/sync/stream APIs retain their behavior.

The audit exception applies only after `check:dependency-security` verifies the registered patch hash, the five patched source-file hashes in every reachable installed copy, and normal/adversarial behavior. Removing or changing the patch fails this gate before audit runs. The raw version-based audit still reports the advisory; passing the gate means that the reviewed local mitigation is present.

`@velaros-ai/script` bundles globby's installed production dependency closure. The shared safe packer stages real files in an isolated directory so Bun workspace symlinks cannot omit the patched bytes. The isolated tarball consumer repeats the source integrity and runtime probes after a fresh installation. Desktop verifies excessive-pattern rejection using its packaged Node and default package resources. Adopt the upstream fixed release and retire the patch, hash pins, and matching exception together when it becomes available.

### `uuid@8.3.2`

`exceljs@4.4.0` constrains `uuid` to version 8. CVE-2026-41907 affects the `v3`, `v5`, and `v6` APIs when callers provide an invalid output buffer. ExcelJS has one UUID call site and invokes only `v4()` without an output buffer. The dependency probe scans the installed ExcelJS runtime and fails if that assumption changes. Remove the ignore when ExcelJS accepts `uuid >=11.1.1`.

## Maintenance rules

- Do not add an audit ignore without a matching entry in this document.
- Prefer a compatible upstream release over an override, and an override over a local patch.
- Keep patches minimal and test the exact failure mode they mitigate.
- Re-run `bun run check:dependency-security` whenever the lockfile changes.

## Removed vulnerable dependencies

Mammoth's argument parser is resolved to `argparse@2.0.1`, which keeps the command-line APIs Mammoth uses and removes the `sprintf-js` dependency affected by [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). The security gate runs Mammoth's actual help, invalid-choice, and DOCX-to-HTML command-line paths and rejects any reachable `sprintf-js`. `@velaros-ai/velaros` bundles the installed Mammoth closure so the compatible parser upgrade also reaches fresh consumers.

`pptxgenjs@4.0.1` used to retain an unused `image-size` dependency whose published versions were affected by CVE-2025-71329 and CVE-2025-71330. Office now vendors the PptxGenJS 4.0.1 ESM runtime with narrow local security patches, plus the unchanged upstream declarations. The vendor README records upstream provenance and the reviewed changes; license-file placement follows the repository public-readiness policy. The patches use Web Crypto for UUIDs and reject media relationship paths that escape the presentation archive root. `scripts/security/checkPatchedDependencies.mjs` pins both vendored file hashes, checks the patch markers, and fails if either file references `image-size`, so the vulnerable package is absent from the production graph instead of being carried behind an audit exception.
