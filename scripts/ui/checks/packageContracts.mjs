import { spawnSync } from "node:child_process";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { safePackPackage } from "../../release/safe-package-pack.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
// README 门只钉「存在 + 确实是中文 + 有实质内容」，刻意不钉章节标题——理由同
// scripts/capabilities/check-arch-boundaries.mjs：钉形状钉不住内容，手抄签名必然与代码脱节。
const MinimumReadmeCharacters = 400;
const ChineseCharacter = /[一-鿿]/;
const UiPackageDirectories = ["ui"];
const utilityTypeModule = "@velaros-ai/ui/utility-types";
const utilityTypeNames = [
  "JsonStringifyReplacer",
  "JsonStringifyReplacerValue",
  "LooseOptional",
  "Nullable",
  "Nullish",
  "Optional",
  "PlainObject",
];

// P7a 合包后 UI 只剩一个发布单元(conversation 是它的 ./conversation 切片)。
for (const packageName of UiPackageDirectories) {
  await verifyPackage(path.join(repositoryRoot, "packages", packageName));
}
await verifyExternalConsumer();

console.info(
  "UI package contracts: metadata, exports, docs, strict external types, and browser bundles are valid.",
);

async function verifyPackage(packageDirectory) {
  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  for (const field of ["description", "license", "repository"]) {
    if (!manifest[field])
      throw new Error(`${manifest.name} is missing package.json#${field}`);
  }
  if (!manifest.engines?.node)
    throw new Error(`${manifest.name} is missing a Node.js engine range`);
  if (manifest.sideEffects === undefined) {
    throw new Error(`${manifest.name} must declare package.json#sideEffects`);
  }
  const readme = await readFile(
    path.join(packageDirectory, "README.md"),
    "utf8",
  );
  if (!ChineseCharacter.test(readme)) {
    throw new Error(`${manifest.name} README.md must be written in Chinese`);
  }
  if (readme.length < MinimumReadmeCharacters) {
    throw new Error(
      `${manifest.name} README.md is ${readme.length} characters — too thin to describe the package`,
    );
  }

  for (const [publicPath, declaration] of Object.entries(
    manifest.exports ?? {},
  )) {
    for (const target of readExportTargets(declaration)) {
      if (target.includes("*")) continue;
      try {
        await access(path.join(packageDirectory, target));
      } catch {
        throw new Error(
          `${manifest.name} export ${publicPath} points to missing ${target}`,
        );
      }
    }
  }
  await assertModuleScopedUtilityTypes(packageDirectory);

  const temporary = await mkdtemp(path.join(tmpdir(), "velaros-ui-contract-"));
  try {
    await safePackPackage({
      destination: temporary,
      packageDirectory,
    });
    const tarballs = (await readdir(temporary)).filter((file) =>
      file.endsWith(".tgz"),
    );
    if (tarballs.length !== 1) {
      throw new Error(`${manifest.name} produced ${tarballs.length} tarballs`);
    }
    const files = capture(
      "tar",
      ["-tzf", tarballs[0]],
      temporary,
    )
      .split(/\r?\n/u)
      .map((file) => file.replaceAll("\\", "/"));
    if (files.includes("package/dist/velaros-globals.d.ts")) {
      throw new Error(
        `${manifest.name} tarball leaks dist/velaros-globals.d.ts`,
      );
    }
    for (const requiredFile of [
      "package/package.json",
      "package/README.md",
      "package/LICENSE",
      "package/NOTICE",
      "package/THIRD_PARTY_NOTICES.md",
      "package/third-party-licenses/tailwindcss-MIT.txt",
    ]) {
      if (!files.includes(requiredFile)) {
        throw new Error(`${manifest.name} tarball is missing ${requiredFile}`);
      }
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function verifyExternalConsumer() {
  const temporary = await mkdtemp(path.join(tmpdir(), "velaros-ui-consumer-"));
  try {
    const packageTarballs = [];
    for (const packageName of UiPackageDirectories) {
      const packageDirectory = path.join(
        repositoryRoot,
        "packages",
        packageName,
      );
      await safePackPackage({
        destination: temporary,
        packageDirectory,
      });
    }
    for (const file of await readdir(temporary)) {
      if (file.endsWith(".tgz"))
        packageTarballs.push(path.join(temporary, file));
    }
    if (packageTarballs.length !== UiPackageDirectories.length) {
      throw new Error(
        `Expected ${UiPackageDirectories.length} UI tarball(s), received ${packageTarballs.length}`,
      );
    }
    const installTargets = [
      ...packageTarballs,
      ...(await packLocalHtmlArtifactsDependency(temporary)),
    ];

    await writeFile(
      path.join(temporary, "package.json"),
      `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
    );
    await writeFile(
      path.join(temporary, ".npmrc"),
      [
        "@velaros-ai:registry=https://npm.pkg.github.com",
        "//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}",
        "",
      ].join("\n"),
    );
    const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
    capture(
      process.platform === "win32" ? process.execPath : "npm",
      [
        ...(process.platform === "win32" ? [npmCli] : []),
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--no-package-lock",
        ...installTargets,
        "@types/react@^19.0.0",
        "@types/react-dom@^19.0.0",
      ],
      temporary,
    );
    await writeFile(
      path.join(temporary, "consumer.tsx"),
      [
        "import * as UI from '@velaros-ai/ui'",
        "import * as Conversation from '@velaros-ai/ui/conversation'",
        ...(await buildEveryExportTypeImports()),
        "import { ToolRendererRegistry } from '@velaros-ai/ui/conversation/tool-render'",
        "import { ToolCallBlock } from '@velaros-ai/ui/conversation/tool-render/ToolCallBlock'",
        "import type { ChatStreamEvent, ToolCallBlock as ToolCall } from '@velaros-ai/ui/conversation/contracts'",
        "import type { ChatStreamPacerOptions } from '@velaros-ai/ui/conversation/stream'",
        "const registry = new ToolRendererRegistry()",
        "const block = null as unknown as ToolCall",
        "const options = null as unknown as ChatStreamPacerOptions<ChatStreamEvent>",
        "void UI",
        "void Conversation",
        "void options",
        "void <ToolCallBlock block={block} registry={registry} />",
        "",
      ].join("\n"),
    );
    await writeFile(
      path.join(temporary, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            jsx: "react-jsx",
            lib: ["ESNext", "DOM", "DOM.Iterable"],
            module: "ESNext",
            moduleResolution: "Bundler",
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: "ES2023",
          },
          files: ["./consumer.tsx"],
        },
        null,
        2,
      )}\n`,
    );
    capture(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules/typescript/bin/tsc"),
        "-p",
        "tsconfig.json",
      ],
      temporary,
    );
    capture(
      "bun",
      [
        "build",
        "consumer.tsx",
        "--target",
        "browser",
        "--format",
        "esm",
        "--external",
        "react",
        "--external",
        "react-dom",
        "--external",
        "react/jsx-runtime",
        "--outdir",
        "bundle",
      ],
      temporary,
    );
    capture(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        "await import('@velaros-ai/ui/conversation/contracts'); await import('@velaros-ai/ui/conversation/stream')",
      ],
      temporary,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function packLocalHtmlArtifactsDependency(destination) {
  const packageDirectory = path.join(
    repositoryRoot,
    "packages",
    "html-artifacts",
  );
  try {
    await access(path.join(packageDirectory, "package.json"));
  } catch {
    return [];
  }

  const manifest = JSON.parse(
    await readFile(path.join(packageDirectory, "package.json"), "utf8"),
  );
  const conversationManifest = JSON.parse(
    await readFile(
      path.join(repositoryRoot, "packages/ui/package.json"),
      "utf8",
    ),
  );
  const requiredVersion =
    conversationManifest.dependencies?.["@velaros-ai/html-artifacts"];
  // 单版本火车:conversation 切片对 html-artifacts 写 workspace:*,由同仓包直接满足,
  // 无版本可比;仍校验包名,防止打错包。
  const isWorkspaceSpec = requiredVersion === "workspace:*";
  const normalizedRequiredVersion = requiredVersion?.replace(/^[~^]/u, "");
  if (
    manifest.name !== "@velaros-ai/html-artifacts" ||
    (!isWorkspaceSpec && manifest.version !== normalizedRequiredVersion)
  ) {
    throw new Error(
      `Local HTML Artifacts package ${manifest.name}@${manifest.version} does not satisfy ${requiredVersion}`,
    );
  }

  const before = new Set(await readdir(destination));
  await safePackPackage({
    destination,
    packageDirectory,
  });
  const created = (await readdir(destination)).filter(
    (file) => file.endsWith(".tgz") && !before.has(file),
  );
  if (created.length !== 1) {
    throw new Error(
      `Expected one local HTML Artifacts tarball, received ${created.length}`,
    );
  }
  return created.map((file) => path.join(destination, file));
}

async function buildEveryExportTypeImports() {
  const imports = [];
  let index = 0;
  for (const packageName of UiPackageDirectories) {
    const packageDirectory = path.join(repositoryRoot, "packages", packageName);
    const packageManifest = JSON.parse(
      await readFile(path.join(packageDirectory, "package.json"), "utf8"),
    );
    for (const [publicPath, conditions] of Object.entries(
      packageManifest.exports ?? {},
    )) {
      const typeTarget =
        typeof conditions === "string"
          ? conditions.endsWith(".d.ts")
            ? conditions
            : undefined
          : conditions?.types;
      if (!typeTarget) continue;
      const specifier =
        publicPath === "."
          ? packageManifest.name
          : `${packageManifest.name}/${publicPath.slice(2)}`;
      imports.push(
        `import type * as Export${index} from ${JSON.stringify(specifier)}`,
      );
      index += 1;
    }
  }
  return imports;
}

async function assertModuleScopedUtilityTypes(packageDirectory) {
  const declarations = await collectFiles(
    path.join(packageDirectory, "dist"),
    ".d.ts",
  );
  for (const declaration of declarations) {
    if (declaration.endsWith(`${path.sep}types${path.sep}utilityTypes.d.ts`))
      continue;
    const sourceText = await readFile(declaration, "utf8");
    if (
      sourceText.includes("velaros-globals.d.ts") ||
      sourceText.includes("declare global")
    ) {
      throw new Error(
        `${path.relative(packageDirectory, declaration)} leaks ambient utility types`,
      );
    }
    const importLine =
      sourceText
        .split("\n")
        .find((line) => line.includes(`from '${utilityTypeModule}'`)) ?? "";
    const declarationBody = sourceText.replace(importLine, "");
    for (const typeName of utilityTypeNames) {
      if (
        new RegExp(`\\b${typeName}\\b`, "u").test(declarationBody) &&
        !new RegExp(`\\b${typeName}\\b`, "u").test(importLine)
      ) {
        throw new Error(
          `${path.relative(packageDirectory, declaration)} uses ${typeName} without a module import`,
        );
      }
    }
  }
}

async function collectFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name);
      return entry.isDirectory()
        ? collectFiles(entryPath, suffix)
        : Promise.resolve(entryPath.endsWith(suffix) ? [entryPath] : []);
    }),
  );
  return files.flat();
}

function readExportTargets(declaration) {
  if (typeof declaration === "string") return [declaration];
  if (!declaration || typeof declaration !== "object") return [];
  return Object.values(declaration).filter(
    (value) => typeof value === "string",
  );
}

function capture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr]
      .filter(Boolean)
      .join("\n")
      .trim();
    throw new Error(`${command} ${args.join(" ")} failed:\n${output}`);
  }
  return result.stdout.trim();
}
