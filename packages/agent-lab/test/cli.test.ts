import { readFile } from "node:fs/promises";

import { describe, expect, test } from "bun:test";

import { agentLabCli } from "../src/exports/index.js";

/** `run` 用不到时给一个会当场报错的加载器：本包不做动态 import。 */
const options = {
  loadRuntime: {
    load: async (): Promise<never> => {
      throw new Error("测试里不加载套件运行时");
    },
  },
};

describe("public CLI", () => {
  test("exposes standard help without requiring implementation knowledge", async () => {
    for (const argument of ["--help", "-h", "help"]) {
      const result = await agentLabCli.run([argument], options);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("VelarOS Agent Lab");
      expect(result.stdout).toContain("validate <journey|job|run|real-task|case>");
      expect(result.stdout).toContain("audit-record <record.json>");
      expect(result.stdout).toContain("certify <文件或目录...>");
    }
  });

  test("ships an executable shell that only wires the process into the package", async () => {
    const source = await readFile(new URL("../bin/velaros-agent-lab.mjs", import.meta.url), "utf8");
    expect(source.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(source).toContain("dist/exports/index.js");
    expect(source).toContain("agentLabCli.run(process.argv.slice(2)");
  });
});
