import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const CliSource = resolve(import.meta.dir, "../src/cli.ts");

describe("public CLI", () => {
  test("exposes standard help without requiring implementation knowledge", () => {
    for (const argument of ["--help", "-h", "help"]) {
      const result = spawnSync(process.execPath, [CliSource, argument], {
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("VelarOS Agent Lab");
      expect(result.stdout).toContain("validate <journey|job|run>");
      expect(result.stdout).toContain("certify <file-or-dir...>");
    }
  });
});
