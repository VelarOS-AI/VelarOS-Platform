#!/usr/bin/env bun
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, relative, resolve } from "node:path";

import { CapabilityPackages, RepositoryUrl } from "./capability-owners.mjs";

const RepoRoot = resolve(import.meta.dir, "../..");
const PackagesRoot = resolve(RepoRoot, "packages");
const SourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const KnownByName = new Map(
  CapabilityPackages.map((item) => [item.name, item]),
);
const ExpectedDirectories = CapabilityPackages.map(
  (item) => item.directory,
).sort();
const ForbiddenHostImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/;
const InternalImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](@velaros-ai\/[^/'"]+)/;
const ElectronImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*)['"]/;
const ConcreteAgentRuntimeImport =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:@velaros-ai\/agent|@velaros-ai\/core\/(?:constants\/(?:workspace[^'"]*|model[^'"]*|memory[^'"]*|knowledge[^'"]*)|spaces\/[^'"]*|utils\/Browser[^'"]*))['"]/;
const CoreTypesImport =
  /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]@velaros-ai\/core\/types['"]/g;
const ConcreteCoreTypeName =
  /\b(?:Browser|Workspace|Workbench|Model|Memory|Knowledge)[A-Z_a-z0-9]*/;
const RequiredPackageFiles = ["dist", "README.md"];
// README 门只钉「存在 + 确实是中文 + 有实质内容」，刻意不钉章节标题。
// 上一版钉的是 docs/api.zh-CN.md 必须存在且含 10 个固定标题——那是在机械执行**文档形状**，
// 而形状钉得住、内容钉不住：签名逐条抄进 markdown 必然与代码脱节（cli 的旧文档甚至手抄了
// 兄弟包的具体版本号，而实际依赖全是 workspace:*）。用户 2026-07-30 判决整套 api.zh-CN 废除、
// README 改中文重写，本门随之改口径：证明包有人写文档，别再规定它长什么样。
const MinimumReadmeCharacters = 400;
const ChineseCharacter = /[一-鿿]/;
// 可移植契约入口:exportKey = package.json exports 键,contractsFile = 对应源文件(合包在切片下),
// modules = 该入口只许 import 的可移植模块集合(相对 contractsFile 所在目录)。
const PortableContracts = [
  {
    packageDirectory: "project",
    packageName: "@velaros-ai/project",
    exportKey: "./contracts",
    contractsFile: "src/contracts.ts",
    modules: new Set([
      "./project-contracts.js",
      "./project-root-source.js",
      "./project-tool-names.js",
    ]),
  },
  {
    packageDirectory: "browser",
    packageName: "@velaros-ai/browser/core",
    exportKey: "./core/contracts",
    contractsFile: "src/core/contracts.ts",
    modules: new Set([
      "./types.js",
      "./BrowserAddressHelper.js",
      "./BrowserScreenshotPolicy.js",
      // 纯闭集/默认值/宽容守卫,零实现依赖——与 ScreenshotPolicy 同性质的契约级模块(2026-08-06 配置单源批)。
      "./BrowserConfigDefaults.js",
      // mod/空间身份常量:纯字符串,零运行时依赖。产品壳的空间门控声明(renderer 也读)只需要
      // 这一个字符串——从 composition/mod 取会把 CloakBrowser 启动器整条 Node 侧依赖拖进渲染
      // bundle,那正是它当初被劈出来的原因。补登记:劈出那笔漏登记,本门从此一直红着。
      "./BrowserModIdentity.js",
      // 「视图没接上」的跨层标记 + 纯判定函数:常量与零依赖 type guard,宿主用它把运行时事实
      // 翻译成可执行指引(见 BrowserViewAttachment 文件头)。
      "./BrowserViewAttachment.js",
    ]),
  },
  {
    packageDirectory: "system",
    packageName: "@velaros-ai/system",
    exportKey: "./contracts",
    contractsFile: "src/contracts.ts",
    modules: new Set(["./SystemContracts.js", "./system-tool-names.js"]),
  },
];

// Workspace packages are flat: every package lives at packages/<package>/.
function listPackageDirectories() {
  const found = [];
  for (const entry of readdirSync(PackagesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(resolve(PackagesRoot, entry.name, "package.json")))
      found.push(entry.name);
  }
  return found;
}

const failures = [];
const fail = (message) => failures.push(message);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

function requirePublicTypeContracts(
  packageDirectory,
  rootSourceFile,
  contractsEntryFile,
  declarationFile,
  typeNames,
) {
  const packageRoot = resolve(PackagesRoot, packageDirectory);
  const rootSourcePath = resolve(packageRoot, rootSourceFile);
  const rootSource = readFileSync(rootSourcePath, "utf8");
  const contractsSource = readFileSync(
    resolve(packageRoot, declarationFile),
    "utf8",
  );
  const contractsSpecifier = `./${relative(
    dirname(rootSourcePath),
    resolve(packageRoot, contractsEntryFile),
  )
    .split("\\")
    .join("/")
    .replace(/\.ts$/u, "")}`;

  if (
    !rootSource.includes(`export type * from '${contractsSpecifier}'`) &&
    !rootSource.includes(`export type * from '${contractsSpecifier}.js'`) &&
    !rootSource.includes(`export * from '${contractsSpecifier}'`) &&
    !rootSource.includes(`export * from '${contractsSpecifier}.js'`)
  ) {
    fail(
      `${packageDirectory}: root entrypoint must export ${contractsSpecifier}`,
    );
  }
  for (const typeName of typeNames) {
    const declaration = new RegExp(
      `\\bexport\\s+(?:interface|type)\\s+${typeName}\\b`,
      "u",
    );
    if (!declaration.test(contractsSource)) {
      fail(`${packageDirectory}: missing public type contract ${typeName}`);
    }
  }
}

function requirePortableContractsEntry({
  packageDirectory,
  packageName,
  exportKey,
  contractsFile,
  modules,
}) {
  const packageRoot = resolve(PackagesRoot, packageDirectory);
  const manifest = readJson(resolve(packageRoot, "package.json"));
  const distBase = `./${contractsFile.replace(/^src\//u, "").replace(/\.ts$/u, "")}`;
  if (
    manifest.exports?.[exportKey]?.types !==
      `./dist/${distBase.slice(2)}.d.ts` ||
    manifest.exports?.[exportKey]?.import !== `./dist/${distBase.slice(2)}.js`
  ) {
    fail(
      `${packageName} ${exportKey} must publish explicit types and import targets`,
    );
  }

  const contractsPath = resolve(packageRoot, contractsFile);
  if (!existsSync(contractsPath)) {
    fail(`${packageName} ${exportKey} is missing ${contractsFile}`);
    return;
  }

  const contractsSource = readFileSync(contractsPath, "utf8");
  const contractImports = [
    ...contractsSource.matchAll(/\bfrom\s+['"]([^'"]+)['"]/gu),
  ].map((match) => match[1]);
  for (const specifier of contractImports) {
    if (!modules.has(specifier)) {
      fail(
        `${packageName}/contracts imports forbidden implementation module ${specifier}`,
      );
    }
  }

  const portableSources = [
    [contractsFile, contractsSource],
    ...[...modules].map((specifier) => {
      const relativePath = specifier
        .replace(/^\.\//u, "")
        .replace(/\.js$/u, ".ts");
      return [
        relativePath,
        readFileSync(resolve(dirname(contractsPath), relativePath), "utf8"),
      ];
    }),
  ];
  const hostDependencyImport =
    /(?:from\s+|import\s*\(|require\()\s*['"](?:node:[^'"]*|execa(?:\/[^'"]*)?)['"]/u;
  for (const [relativePath, source] of portableSources) {
    if (hostDependencyImport.test(source)) {
      fail(
        `${packageName}/contracts portable module ${relativePath} imports a host dependency`,
      );
    }
  }
}

function walk(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = resolve(directory, entry);
    const stats = statSync(path);
    if (stats.isDirectory()) return walk(path);
    return SourceExtensions.has(extname(path)) ? [path] : [];
  });
}

function dependencyEntries(manifest) {
  return [
    ["dependencies", manifest.dependencies ?? {}],
    ["optionalDependencies", manifest.optionalDependencies ?? {}],
    ["peerDependencies", manifest.peerDependencies ?? {}],
    ["devDependencies", manifest.devDependencies ?? {}],
  ];
}

// VelarOS-Platform 单版本火车:packages/ 是全平台包的公共家,冻结面从「整个 packages/」收敛为
// 「capabilities 域的包集合」。域包清单单源 = 仓根 package.json 的
// velaros.domainPackages.capabilities;新增能力包必须同时登记该清单与 capability-owners.mjs。
const RootManifest = readJson(resolve(RepoRoot, "package.json"));
const RegisteredDirectories = [
  ...(RootManifest.velaros?.domainPackages?.capabilities ?? []),
].sort();
const PackageDirectories = listPackageDirectories();
const WorkspacePackageNames = new Set(
  PackageDirectories.map(
    (directory) =>
      readJson(resolve(PackagesRoot, directory, "package.json")).name,
  ),
);
const actualDirectories = PackageDirectories.filter((name) =>
  RegisteredDirectories.includes(name),
).sort();
if (
  JSON.stringify(RegisteredDirectories) !== JSON.stringify(ExpectedDirectories)
) {
  fail(
    `package registry drift: velaros.domainPackages.capabilities = ${RegisteredDirectories.join(", ")}, owners table = ${ExpectedDirectories.join(", ")}`,
  );
}
if (JSON.stringify(actualDirectories) !== JSON.stringify(ExpectedDirectories)) {
  fail(
    `package set drift: expected ${ExpectedDirectories.join(", ")}, got ${actualDirectories.join(", ")}`,
  );
}

for (const expected of CapabilityPackages) {
  const packageRoot = resolve(PackagesRoot, expected.directory);
  const manifest = readJson(resolve(packageRoot, "package.json"));
  if (manifest.name !== expected.name) {
    fail(
      `${expected.directory}: expected package name ${expected.name}, got ${manifest.name}`,
    );
  }
  if (manifest.repository?.url !== RepositoryUrl) {
    fail(`${expected.name}: repository URL must be ${RepositoryUrl}`);
  }
  if (manifest.repository?.directory !== `packages/${expected.directory}`) {
    fail(
      `${expected.name}: repository.directory must be packages/${expected.directory}`,
    );
  }
  if (manifest.private === true) {
    fail(
      `${expected.name}: capability packages must remain independently publishable`,
    );
  }
  if (
    typeof manifest.description !== "string" ||
    manifest.description.trim().length < 20
  ) {
    fail(
      `${expected.name}: package description must explain the public responsibility`,
    );
  }
  if (manifest.license !== "Apache-2.0") {
    fail(`${expected.name}: package license must be Apache-2.0`);
  }
  if (manifest.engines?.node !== ">=20.0.0") {
    fail(`${expected.name}: engines.node must be >=20.0.0`);
  }
  if (manifest.sideEffects !== false) {
    fail(`${expected.name}: package must declare sideEffects=false`);
  }
  for (const requiredFile of RequiredPackageFiles) {
    if (!manifest.files?.includes(requiredFile)) {
      fail(`${expected.name}: package files must include ${requiredFile}`);
    }
  }
  if (!manifest.files?.includes("LICENSE")) {
    fail(`${expected.name}: package files must include LICENSE`);
  }
  // 入口冻结:合包按切片子路径给入口(无根导出——切片运行面互斥),单入口包仍是 '.'。
  for (const entrySubpath of expected.entrySubpaths) {
    const entry = manifest.exports?.[entrySubpath];
    if (
      typeof entry !== "object" ||
      typeof entry.types !== "string" ||
      typeof entry.import !== "string"
    ) {
      fail(
        `${expected.name}: exports["${entrySubpath}"] must declare types and import targets`,
      );
    }
  }
  if (
    expected.entrySubpaths.includes(".") !== Boolean(manifest.exports?.["."])
  ) {
    fail(
      `${expected.name}: root export presence must match the owners table entrySubpaths`,
    );
  }
  if (
    manifest.publishConfig?.access !== "public" ||
    manifest.publishConfig?.registry !== "https://npm.pkg.github.com"
  ) {
    fail(
      `${expected.name}: publishConfig must target public GitHub Packages`,
    );
  }

  const readmePath = resolve(packageRoot, "README.md");
  const licensePath = resolve(packageRoot, "LICENSE");
  if (!existsSync(readmePath)) {
    fail(`${expected.name}: missing README.md`);
  } else {
    const readme = readFileSync(readmePath, "utf8");
    if (!ChineseCharacter.test(readme)) {
      fail(`${expected.name}: README.md must be written in Chinese`);
    }
    if (readme.length < MinimumReadmeCharacters) {
      fail(
        `${expected.name}: README.md is ${readme.length} characters — too thin to describe the package`,
      );
    }
  }
  if (!existsSync(licensePath)) {
    fail(`${expected.name}: missing package LICENSE`);
  }

  for (const [section, dependencies] of dependencyEntries(manifest)) {
    for (const [name, version] of Object.entries(dependencies)) {
      const internal = KnownByName.get(name);
      if (internal) {
        if (version !== "workspace:*") {
          fail(
            `${expected.name}: internal ${section} dependency ${name} must use workspace:*`,
          );
        }
        if (
          expected.owner !== internal.owner &&
          expected.owner !== "composition"
        ) {
          fail(
            `${expected.name}: ${expected.owner} owner cannot depend on ${internal.owner} owner (${name})`,
          );
        }
        continue;
      }
      // 单版本火车:Core / Kernel 等平台包已与能力包同仓；同仓依赖一律 workspace:*,
      // 发布时由包管理器代换成具体版本。
      if (WorkspacePackageNames.has(name)) {
        if (version !== "workspace:*") {
          fail(
            `${expected.name}: platform ${section} dependency ${name} must use workspace:* (single version train)`,
          );
        }
        continue;
      }
      if (version === "workspace:*") {
        fail(
          `${expected.name}: external ${section} dependency ${name} cannot use workspace:*`,
        );
      }
    }
  }

  const sourceRoot = resolve(packageRoot, "src");
  const electronAllowedRoots = expected.electronRoots.map((slice) =>
    resolve(sourceRoot, slice),
  );
  for (const path of walk(sourceRoot)) {
    const source = readFileSync(path, "utf8");
    if (ForbiddenHostImport.test(source)) {
      fail(`${expected.name}: host import in ${relative(packageRoot, path)}`);
    }
    if (ConcreteAgentRuntimeImport.test(source)) {
      fail(
        `${expected.name}: capability code must use an explicit Agent contract or runtime subpath in ${relative(packageRoot, path)}`,
      );
    }
    for (const match of source.matchAll(CoreTypesImport)) {
      if (
        ["browser", "workspace"].includes(expected.owner) &&
        ConcreteCoreTypeName.test(match[1])
      ) {
        fail(
          `${expected.name}: concrete Core type import in ${relative(packageRoot, path)}`,
        );
      }
    }
    if (
      ElectronImport.test(source) &&
      !electronAllowedRoots.some((root) => path.startsWith(`${root}/`))
    ) {
      fail(
        `${expected.name}: only ${expected.electronRoots.map((slice) => `src/${slice}`).join(" / ") || "(none)"} may import Electron (${relative(packageRoot, path)})`,
      );
    }
    for (const match of source.matchAll(
      new RegExp(InternalImport.source, "g"),
    )) {
      const imported = KnownByName.get(match[1]);
      if (!imported) continue;
      if (
        expected.owner !== imported.owner &&
        expected.owner !== "composition"
      ) {
        fail(
          `${expected.name}: source crosses ${expected.owner} -> ${imported.owner} in ${relative(packageRoot, path)}`,
        );
      }
    }
  }
}

for (const obsoleteDirectory of [
  "workspace",
  "workspace-agent-tools",
  "system-tools",
]) {
  if (existsSync(resolve(PackagesRoot, obsoleteDirectory)))
    fail(
      `obsolete capability package directory must be removed: ${obsoleteDirectory}`,
    );
}

for (const contracts of PortableContracts) {
  requirePortableContractsEntry(contracts);
}

requirePublicTypeContracts(
  "browser",
  "src/core/index.ts",
  "src/core/types.ts",
  "src/core/types.ts",
  ["BrowserActionPolicyConfig", "BrowserAutomationMode"],
);
requirePublicTypeContracts(
  "project",
  "src/index.ts",
  "src/contracts.ts",
  "src/project-contracts.ts",
  ["ProjectGitRemoteActionOptions", "ProjectRootEntry"],
);
requirePublicTypeContracts(
  "office",
  "src/index.ts",
  "src/contracts.ts",
  "src/OfficeContracts.ts",
  ["OfficeEnvironmentInspection"],
);

const officeContractsSource = readFileSync(
  resolve(PackagesRoot, "office/src/OfficeContracts.ts"),
  "utf8",
);
if (/\bNodeJS\./u.test(officeContractsSource)) {
  fail(
    "office: public OfficeContracts must not depend on NodeJS ambient types",
  );
}

if (failures.length > 0) {
  console.error(`Capability architecture check failed (${failures.length}):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

for (const owner of [
  ...new Set(CapabilityPackages.map((item) => item.owner)),
]) {
  const names = CapabilityPackages.filter((item) => item.owner === owner).map(
    (item) => item.name,
  );
  console.info(`✓ ${owner}: ${names.join(", ")}`);
}
console.info(
  "✓ capability ownership, dependency direction, release metadata, and host boundaries",
);
