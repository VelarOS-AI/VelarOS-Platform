// 本包自己的架构门：核对对外形状、纯测量目录的纯度、可执行壳的形态与产品文件是否齐全。
// 模块结构（五个目录、合同、分层、卡片、不变量）由仓库层的 check:module-ownership 管，这里不重复。
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

const PackageRoot = resolve(import.meta.dirname, '..')
const SourceRoot = join(PackageRoot, 'src')
/** 纯测量与渲染：这三个目录里的代码不许碰 Node 运行时，也不许发网络请求。 */
const PureRoots = ['utils/measure', 'utils/render', 'utils/wire']
/** 对外入口：由合同控制，只有这两个。 */
const ExpectedExports = ['.', './contracts']
/** 装出来的命令与它的可执行壳。 */
const BinaryCommand = 'velaros-agent-lab'
const BinaryTarget = `./bin/${BinaryCommand}.mjs`
const BinaryShebang = '#!/usr/bin/env node'
/** `src` 下不许有副作用：这几样一出现就说明有东西在 import 时就跑起来了，或者在包里直接写了进程的流。 */
const SideEffectPatterns = [
  /\bprocess\.(?:stdout|stderr)\.write\b/,
  /\bprocess\.exit\s*\(/,
  /\bprocess\.exitCode\b/,
]
/** 本包不读任何环境变量：地址、凭据、驱动全部从注入面进来。 */
const EnvironmentPattern = /\bprocess\.env\b/

/** 去掉注释再扫代码：说明文字里提到 `process.exitCode`、`VELAR_HOOKS_*` 是在讲它们归谁，不是在用它们。 */
function withoutComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
}

function packageRelative(path) {
  return relative(PackageRoot, path).split(sep).join('/')
}

async function files(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name)
      return entry.isDirectory() ? files(path) : [path]
    })
  )
  return nested.flat()
}

function fail(message) {
  process.stderr.write(`agent-lab architecture: ${message}\n`)
  process.exitCode = 1
}

const manifest = JSON.parse(await readFile(join(PackageRoot, 'package.json'), 'utf8'))

const actualExports = Object.keys(manifest.exports ?? {}).sort()
if (JSON.stringify(actualExports) !== JSON.stringify(ExpectedExports)) {
  fail(`public exports drifted: ${actualExports.join(', ')}`)
}
if (manifest.private === true || manifest.bin?.[BinaryCommand] !== BinaryTarget) {
  fail(`package must remain publishable with the ${BinaryCommand} CLI at ${BinaryTarget}`)
}
if (!(manifest.files ?? []).includes('bin')) fail('package.json files must ship the bin/ directory')
if (Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith('@velaros-ai/'))) {
  fail('host-independent core cannot depend on another VelarOS package')
}

const binaryPath = join(PackageRoot, 'bin', `${BinaryCommand}.mjs`)
const binarySource = await readFile(binaryPath, 'utf8').catch(() => null)
if (binarySource === null) fail(`missing executable shell: bin/${BinaryCommand}.mjs`)
else {
  if (!binarySource.startsWith(BinaryShebang))
    fail(`bin/${BinaryCommand}.mjs must start with ${BinaryShebang}`)
  if (!binarySource.includes('dist/index.js')) {
    fail(`bin/${BinaryCommand}.mjs must hand the process to dist/index.js`)
  }
}

const sourceFiles = (await files(SourceRoot)).filter((path) =>
  ['.ts', '.tsx'].includes(extname(path))
)
for (const path of sourceFiles) {
  const source = withoutComments(await readFile(path, 'utf8'))
  const name = packageRelative(path)
  if (/\b(?:electron|@electron)\b/.test(source)) fail(`${name} imports or names Electron`)
  if (/tools\/agent-lab|agent-lab\/runs/.test(source)) {
    fail(`${name} reaches into the retired Desktop implementation`)
  }
  if (EnvironmentPattern.test(source)) {
    fail(
      `${name} reads an environment variable; the host injects addresses, credentials, and drivers instead`
    )
  }
  for (const pattern of SideEffectPatterns) {
    if (pattern.test(source))
      fail(`${name} has a process side effect; only bin/ may touch the process`)
  }
}

for (const root of PureRoots) {
  for (const path of (await files(join(SourceRoot, root))).filter(
    (item) => extname(item) === '.ts'
  )) {
    const source = await readFile(path, 'utf8')
    const name = packageRelative(path)
    if (/from\s+['"]node:|import\s*\(['"]node:/.test(source)) {
      fail(`${name} is a pure measurement module and cannot import Node runtime APIs`)
    }
    if (/\bfetch\s*\(|\bXMLHttpRequest\b/.test(source)) {
      fail(`${name} is a pure measurement module and cannot perform network I/O`)
    }
  }
}

const requiredFiles = [
  'README.md',
  'CHANGELOG.md',
  'MODULE.md',
  `bin/${BinaryCommand}.mjs`,
  'src/index.ts',
  'src/contracts.ts',
  'spec/invariants.md',
  'spec/acceptance.test.ts',
  'spec/support.ts',
  'test/protocol.test.ts',
  'test/real-workload.test.ts',
  'test/runner.test.ts',
  'test/archive-report.test.ts',
  'test/cli.test.ts',
  'test/detectors.test.ts',
  'test/statistics-certification.test.ts',
  'test/fixtures/legacy-equivalence.tsv',
]
const present = new Set((await files(PackageRoot)).map(packageRelative))
for (const path of requiredFiles) {
  if (!present.has(path)) fail(`required product surface is missing: ${path}`)
}

const legacySnapshot = await readFile(
  join(PackageRoot, 'test/fixtures/legacy-equivalence.tsv'),
  'utf8'
).then((source) => source.replaceAll('\r\n', '\n'))
const legacyRows = legacySnapshot.trim().split('\n')
if (
  legacyRows[0] !== 'schema\tagent-lab/legacy-equivalence-snapshot@1' ||
  !legacyRows[1]?.includes('archives=52') ||
  legacyRows.length !== 55
) {
  fail('legacy equivalence snapshot header or archive count drifted')
}
for (const [index, row] of legacyRows.slice(3).entries()) {
  const fields = row.split('\t')
  if (fields.length !== 5 || !/^[a-f0-9]{64}$/.test(fields[3] ?? '')) {
    fail(`legacy equivalence snapshot row ${index + 1} is invalid`)
  }
}

if (!process.exitCode) {
  process.stdout.write(
    'agent-lab architecture: public surface, purity, executable shell, and product files verified\n'
  )
}
