import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";

const PackageRoot = resolve(import.meta.dirname, "..");
const SourceRoot = join(PackageRoot, "src");
const PureRoots = [
  "protocol",
  "detect",
  "report",
  "statistics",
  "certification",
];
const ExpectedExports = [
  ".",
  "./archive",
  "./certification",
  "./detect",
  "./drivers",
  "./protocol",
  "./report",
  "./runner",
  "./statistics",
];

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat();
}

function fail(message) {
  process.stderr.write(`agent-lab architecture: ${message}\n`);
  process.exitCode = 1;
}

const manifest = JSON.parse(
  await readFile(join(PackageRoot, "package.json"), "utf8"),
);
const actualExports = Object.keys(manifest.exports ?? {}).sort();
if (JSON.stringify(actualExports) !== JSON.stringify(ExpectedExports)) {
  fail(`public exports drifted: ${actualExports.join(", ")}`);
}
if (
  manifest.private === true ||
  manifest.bin?.["velaros-agent-lab"] !== "./dist/cli.js"
) {
  fail("package must remain publishable with the velaros-agent-lab CLI");
}
if (
  Object.keys(manifest.dependencies ?? {}).some((name) =>
    name.startsWith("@velaros-ai/"),
  )
) {
  fail(
    "host-independent core cannot depend on another VelarOS product package",
  );
}

const sourceFiles = (await files(SourceRoot)).filter((path) =>
  [".ts", ".tsx"].includes(extname(path)),
);
for (const path of sourceFiles) {
  const source = await readFile(path, "utf8");
  const name = relative(PackageRoot, path);
  if (/\b(?:electron|@electron)\b/.test(source))
    fail(`${name} imports or names Electron`);
  if (/tools\/agent-lab|agent-lab\/runs/.test(source)) {
    fail(`${name} reaches into the retired Desktop implementation`);
  }
}

for (const root of PureRoots) {
  for (const path of (await files(join(SourceRoot, root))).filter(
    (item) => extname(item) === ".ts",
  )) {
    const source = await readFile(path, "utf8");
    const name = relative(PackageRoot, path);
    if (/from\s+['"]node:|import\s*\(['"]node:/.test(source)) {
      fail(
        `${name} is a pure measurement module and cannot import Node runtime APIs`,
      );
    }
    if (/\bfetch\s*\(|\bXMLHttpRequest\b/.test(source)) {
      fail(
        `${name} is a pure measurement module and cannot perform network I/O`,
      );
    }
  }
}

const requiredFiles = [
  "README.md",
  "CHANGELOG.md",
  "src/cli.ts",
  "src/index.ts",
  "test/protocol.test.ts",
  "test/runner.test.ts",
  "test/archive-report.test.ts",
  "test/cli.test.ts",
  "test/detectors.test.ts",
  "test/statistics-certification.test.ts",
  "test/fixtures/legacy-equivalence.tsv",
];
const present = new Set(
  (await files(PackageRoot)).map((path) => relative(PackageRoot, path)),
);
for (const path of requiredFiles) {
  if (!present.has(path)) fail(`required product surface is missing: ${path}`);
}

const legacySnapshot = await readFile(
  join(PackageRoot, "test/fixtures/legacy-equivalence.tsv"),
  "utf8",
);
const legacyRows = legacySnapshot.trim().split("\n");
if (
  legacyRows[0] !== "schema\tagent-lab/legacy-equivalence-snapshot@1" ||
  !legacyRows[1]?.includes("archives=52") ||
  legacyRows.length !== 55
) {
  fail("legacy equivalence snapshot header or archive count drifted");
}
for (const [index, row] of legacyRows.slice(3).entries()) {
  const fields = row.split("\t");
  if (fields.length !== 5 || !/^[a-f0-9]{64}$/.test(fields[3] ?? "")) {
    fail(`legacy equivalence snapshot row ${index + 1} is invalid`);
  }
}

if (!process.exitCode) {
  process.stdout.write(
    "agent-lab architecture: public surface, purity, and product files verified\n",
  );
}
