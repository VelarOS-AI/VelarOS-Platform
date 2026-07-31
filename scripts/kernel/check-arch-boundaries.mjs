#!/usr/bin/env bun
// 用途:Kernel 架构边界哨兵。基线=零违规。
//
// P2 库化后的拓扑:内核本体住 core,进程形态住 kernel 域三包。
//   packages/core/src/kernel  Kernel 库本体(abi / protocol / contracts / host / runtime)——是库不是进程
//   packages/kernel-client         瘦客户端与 serve 模式的接入入口
//   packages/kernel-serve/src/daemon   serve 部署模式的配件(daemon / 本机 RPC 前脸 / 进程内传输)
//   packages/kernel-serve/src/updater  共享 Runtime 的安装/切换/回滚
//
// 七道防线:
//  ① 包集合冻结:Kernel 域只能是 kernel-client 与 kernel-serve 两个包(内核本体归 core 域)。
//  ② host 无关:四处源码根都禁 import electron / @electron/* / Desktop 传输 / renderer·main 别名。
//  ③ 依赖方向:**core 不得依赖 kernel-daemon / kernel-client**(库不知进程,P2 新增反向约束);
//     client 不得依赖 daemon 内部实现与 updater;updater 不得依赖 client/内核本体/daemon;
//     Mod 与产品都不得触达 daemon 内部实现。
//  ④ 协议单一事实来源:wire schema 只能有一处实现(packages/core/src/kernel/protocol)。
//  ⑤ 审批端口教义(宪章 §4 ApprovalPort 默认 deny):审批动词必须经 ctx.approval.*。
//  ⑥ Kernel 不得依赖任何具体能力实现(browser / workspace / memory / model 等由产品装配根注入)。
//  ⑦ 发布必须绑定精确 source/ref/tag 和同一已验明 tarball。
//
// 有意的基线变化:VELAROS_ARCH_BASELINE_UPDATE=1 bun scripts/check-arch-boundaries.mjs 重生成基线,
// 并在提交信息里说明差异。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(HERE, '../..')
const BaselinePath = join(RepoRoot, 'baselines', 'kernel', 'arch-boundaries-baseline.json')
const UpdateBaseline = process.env.VELAROS_ARCH_BASELINE_UPDATE === '1'

const SourceExtensions = new Set(['.ts', '.tsx'])

/** Kernel 域的两个包(目录名即包名后缀)。内核本体已并入 core 域,不在此列。 */
const PublicPackages = ['kernel-client', 'kernel-serve']

/** kernel-serve 的 updater 切片:相对 import 触达 daemon 切片即违规(合包后的方向看守)。 */
const UpdaterReachesDaemonPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"]\.{1,2}(?:\/\.\.)*\/daemon(?:\/[^'"]*)?['"]/

/** 内核本体的源码根(core 域,但受同一套 Kernel 边界约束)。 */
const KernelLibraryRoot = 'packages/core/src/kernel'

/** 需要 host 无关的全部源码根。 */
const HostNeutralRoots = [
  KernelLibraryRoot,
  ...PublicPackages.map((name) => `packages/${name}/src`),
]

const ForbiddenHostImportPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*|@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/

const ApprovalVerbOnExecutionPattern =
  /(?<![A-Za-z0-9_$.])(?:this\.)?ctx\.execution(?![A-Za-z0-9_$])\s*[!?]?\s*\.\s*(awaitConfirmation(?:Decision)?)\b/

const ConcreteCapabilityImportPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"]@velaros-ai\/(?:model|workspace|computer|system-tools|office-tools|browser|memory|agent)(?:\/[^'"]*)?['"]/

function normalizeSeparators(pathText) {
  return pathText.split('\\').join('/')
}

function collectSourceFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'out' || entry === 'build') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full))
      continue
    }
    if (full.endsWith('.d.ts')) continue
    const dot = full.lastIndexOf('.')
    if (dot >= 0 && SourceExtensions.has(full.slice(dot))) out.push(full)
  }
  return out
}

// 剥注释:把 // 与 /* */ 注释段替换为等长空白(保留换行),字符串字面量内的注释符号不误剥。
function stripCodeComments(source) {
  let result = ''
  let state = 'code'
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        result += '  '
        i += 1
      } else if (ch === '/' && next === '*') {
        state = 'block'
        result += '  '
        i += 1
      } else {
        if (ch === "'") state = 'single'
        else if (ch === '"') state = 'double'
        else if (ch === '`') state = 'template'
        result += ch
      }
    } else if (state === 'line') {
      if (ch === '\n') {
        state = 'code'
        result += ch
      } else {
        result += ' '
      }
    } else if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        result += '  '
        i += 1
      } else {
        result += ch === '\n' ? '\n' : ' '
      }
    } else {
      result += ch
      if (ch === '\\') {
        result += source[i + 1] ?? ''
        i += 1
      } else if (
        (state === 'single' && ch === "'")
        || (state === 'double' && ch === '"')
        || (state === 'template' && ch === '`')
      ) {
        state = 'code'
      }
    }
  }
  return result
}

function scanLines(roots, test, build) {
  const violations = []
  for (const root of roots) {
    const sourceDir = resolve(RepoRoot, root)
    if (!existsSync(sourceDir)) continue
    for (const file of collectSourceFiles(sourceDir)) {
      const relativeFile = normalizeSeparators(relative(RepoRoot, file))
      const lines = stripCodeComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        const match = test(line)
        if (!match) return
        violations.push(build(relativeFile, index + 1, match, line))
      })
    }
  }
  return violations
}

// —— 防线① 包集合冻结 ——
// VelarOS-Platform 单版本火车:packages/ 是全平台包的公共家,冻结面从「整个 packages/」收敛为
// 「Kernel 域的包集合」。域包清单单源 = 仓根 package.json 的 velaros.domainPackages.kernel;
// 两处必须一致,新增 Kernel 包要同时登记 PublicPackages 与该清单,漏登即红。
const DomainPackageDirectories =
  JSON.parse(readFileSync(join(RepoRoot, 'package.json'), 'utf8')).velaros
    ?.domainPackages?.kernel ?? []

function scanPackageSet() {
  const owned = new Set(PublicPackages)
  const registered = new Set(DomainPackageDirectories)
  const actual = readdirSync(resolve(RepoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // 只看本域:已登记的,加上任何未登记却自称 kernel-* 的偷渡包。
    .filter((name) => registered.has(name) || /^kernel-/u.test(name))
    .sort()
  const unregistered = [...owned].filter((name) => !registered.has(name))
  const unexpected = [
    ...actual.filter((name) => !owned.has(name)),
    ...unregistered.map((name) => `${name}(未登记进仓根 velaros.domainPackages.kernel)`),
  ]
  const missing = [...owned].filter((name) => !actual.includes(name))
  const violations = []
  if (unexpected.length > 0) {
    violations.push({
      rule: 'kernel-package-set',
      fingerprint: `kernel-package-set::unexpected::${unexpected.join(',')}`,
      message: `Kernel 域只应包含 ${[...owned].join(' / ')},发现额外包:${unexpected.join(', ')}。内核本体请放 packages/core/src/kernel。`,
    })
  }
  if (missing.length > 0) {
    violations.push({
      rule: 'kernel-package-set',
      fingerprint: `kernel-package-set::missing::${missing.join(',')}`,
      message: `Kernel 域三包缺失:${missing.join(', ')}。`,
    })
  }
  return violations
}

// —— 防线② host 无关 ——
function scanHostNeutrality() {
  return scanLines(
    HostNeutralRoots,
    (line) => ForbiddenHostImportPattern.test(line),
    (file, line) => ({
      rule: 'kernel-host-neutrality',
      fingerprint: `kernel-host-neutrality::${file}:${line}`,
      message: `${file}:${line}: Kernel 必须 host 无关,禁止 import electron/@electron 或 Desktop 传输与 renderer/main 路径。`,
    }),
  )
}

// —— 防线③ 依赖方向 ——
const InternalImplementationPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"][^'"]*\/src\/(rpc|daemon|launcher|internal)(?:\/[^'"]*)?['"]/

function importsPackage(line, names) {
  const pattern = new RegExp(
    `(?:from\\s+|import\\s*\\(|require\\()\\s*['"](?:${names.join('|')})(?:/[^'"]*)?['"]`,
  )
  return pattern.test(line)
}

function scanDependencyDirection() {
  const violations = []

  // P2 反向约束:内核本体是**库**,对进程形态一无所知——core 不得依赖 daemon 与 client。
  violations.push(
    ...scanLines(
      ['packages/core/src'],
      (line) =>
        importsPackage(line, [
          '@velaros-ai/kernel-serve',
          '@velaros-ai/kernel-client',
        ]),
      (file, line) => ({
        rule: 'core-kernel-process-independence',
        fingerprint: `core-kernel-process-independence::${file}:${line}`,
        message: `${file}:${line}: 内核本体(core)是库不是进程,不得依赖 kernel-serve / kernel-client(宪章 §15.1 原则一)。`,
      }),
    ),
  )

  // kernel-client 只能持协议契约与内核契约,不得触达 daemon 内部实现。
  violations.push(
    ...scanLines(
      ['packages/kernel-client/src'],
      (line) =>
        InternalImplementationPattern.test(line)
        || importsPackage(line, ['@velaros-ai/kernel-serve']),
      (file, line) => ({
        rule: 'client-dependency-direction',
        fingerprint: `client-dependency-direction::${file}:${line}`,
        message: `${file}:${line}: kernel-client 不得依赖 kernel-serve(RPC/Daemon/Launcher 内部实现与 Updater)。`,
      }),
    ),
  )

  // kernel-updater 只管字节与版本指针,不参与能力调用。
  violations.push(
    ...scanLines(
      ['packages/kernel-serve/src/updater'],
      (line) =>
        InternalImplementationPattern.test(line)
        || UpdaterReachesDaemonPattern.test(line)
        || importsPackage(line, [
          '@velaros-ai/kernel-client',
          '@velaros-ai/kernel-serve',
          '@velaros-ai/core',
        ]),
      (file, line) => ({
        rule: 'updater-dependency-direction',
        fingerprint: `updater-dependency-direction::${file}:${line}`,
        message: `${file}:${line}: kernel-serve 的 updater 切片只负责安装/切换/回滚,不得依赖 Client、daemon 切片或内核本体。`,
      }),
    ),
  )

  // package.json 层面的同一约束(声明即违规,不必等到 import)。
  // 注:updater 合包后没有独立清单,它的「不得依赖 Client/Daemon/core」全部由上面的**源码层**
  // 规则(含相对 import 触达 daemon 切片)看守;清单层只剩 client 与 core 两条。
  const manifestBans = {
    'kernel-client': ['@velaros-ai/kernel-serve'],
    core: ['@velaros-ai/kernel-client', '@velaros-ai/kernel-serve'],
  }
  for (const [packageName, banned] of Object.entries(manifestBans)) {
    const manifestPath = resolve(RepoRoot, 'packages', packageName, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const dependencyName of Object.keys(manifest[section] ?? {})) {
        if (!banned.includes(dependencyName)) continue
        violations.push({
          rule: 'package-dependency-direction',
          fingerprint: `package-dependency-direction::packages/${packageName}/package.json::${section}::${dependencyName}`,
          message: `packages/${packageName}/package.json: ${section} 不得声明 ${dependencyName}(依赖方向反了)。`,
        })
      }
    }
  }

  return violations
}

// —— 防线④ 协议单一事实来源 ——
function scanProtocolSingleSource() {
  const violations = []

  const protocolHome = resolve(RepoRoot, KernelLibraryRoot, 'protocol')
  if (!existsSync(protocolHome)) {
    violations.push({
      rule: 'protocol-single-source',
      fingerprint: 'protocol-single-source::missing-home',
      message: `wire 协议实现目录 ${KernelLibraryRoot}/protocol 不存在;协议必须有唯一实现处。`,
    })
    return violations
  }

  // 协议 zod schema 只能定义在唯一实现处;别处重新定义 wire schema 即为复制协议。
  const wireSchemaDefinition = /export\s+const\s+\w*(?:Handshake|CapabilityCall|ModuleDescriptor|ScopeRef|ResourceRef|CapabilityToken)\w*Schema\s*=/
  violations.push(
    ...scanLines(
      PublicPackages.map((name) => `packages/${name}/src`),
      (line) => wireSchemaDefinition.test(line),
      (file, line) => ({
        rule: 'protocol-single-source',
        fingerprint: `protocol-single-source::duplicate::${file}:${line}`,
        message: `${file}:${line}: wire schema 只能定义在 ${KernelLibraryRoot}/protocol;此处是第二份协议定义。`,
      }),
    ),
  )

  return violations
}

// —— 防线⑤ 审批端口教义 ——
function scanApprovalPort() {
  return scanLines(
    HostNeutralRoots,
    (line) => ApprovalVerbOnExecutionPattern.exec(line),
    (file, line, match) => ({
      rule: 'require-approval-port',
      fingerprint: `require-approval-port::${file}:${line}::${match[1]}`,
      message: `${file}:${line}: 审批动词 \`${match[1]}\` 写在 \`ctx.execution\` 接收面上;审批必须经 \`ctx.approval.${match[1]}(...)\`(宪章 §4 ApprovalPort 默认 deny)。`,
    }),
  )
}

// —— 防线⑥ 不得依赖具体能力实现 ——
function scanConcreteCapabilityDirection() {
  const violations = scanLines(
    HostNeutralRoots,
    (line) => ConcreteCapabilityImportPattern.test(line),
    (file, line) => ({
      rule: 'concrete-capability-direction',
      fingerprint: `concrete-capability-direction::${file}:${line}`,
      message: `${file}:${line}: Kernel 不得 import 具体能力实现;请由能力包反向依赖 Kernel 并在产品装配根注入。`,
    }),
  )

  for (const packageName of PublicPackages) {
    const manifestPath = resolve(RepoRoot, 'packages', packageName, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const section of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const dependencyName of Object.keys(manifest[section] ?? {})) {
        if (!ConcreteCapabilityImportPattern.test(`from '${dependencyName}'`)) continue
        violations.push({
          rule: 'concrete-capability-direction',
          fingerprint: `concrete-capability-direction::packages/${packageName}/package.json::${section}::${dependencyName}`,
          message: `packages/${packageName}/package.json: Kernel 不得在 ${section} 声明具体能力 ${dependencyName}。`,
        })
      }
    }
  }
  return violations
}

// —— 防线⑦ 发布必须绑定精确源码身份并发布已验明的同一 tarball ——
//
// 2026-08 合并:并仓前每域各核验自己那套 scripts/<domain>/release/*(七份功能等价的副本),
// 现在全域共用 scripts/release/ 一条链,故契约指向那一份。**核验的语义一条没减,反而多一条**:
// 旧 workflow 只有身份核验、没有 publish 步骤,所以「发布链存在」当时无法机械断言;
// 现在 workflow 必须同时出现 verify 与 publish 两步,漏接 publish 即红。
// 门与被核验文件刻意**不共享代码**:每域独立按字面标记核对,任何一域的门被改弱不会连带放过其它域
// (失败方向优先于去重——这里的重复是防线冗余,不是待清理的债)。
function scanReleaseIdentityBoundary() {
  const violations = []
  const contracts = [
    {
      file: '.github/workflows/release-packages.yml',
      markers: [
        "if: github.ref_type == 'tag'",
        'node scripts/release/verify-release-ref.mjs',
        'node scripts/release/publish-packages.mjs',
      ],
    },
    {
      file: 'scripts/release/verify-release-ref.mjs',
      markers: [
        'const expectedTag = `v${rootManifest.version}`',
        "!['push', 'workflow_dispatch'].includes(eventName)",
        "refType !== 'tag'",
        'ref !== `refs/tags/${expectedTag}`',
        'refName !== expectedTag',
      ],
    },
    {
      file: 'scripts/release/publish-packages.mjs',
      markers: [
        "runForOutput('git', ['rev-parse', 'HEAD'], root)",
        "['status', '--porcelain', '--untracked-files=all']",
        // 发布器自己也必须核验运行时 ref 就是那个 tag(并仓前只有 model 那份这么做,
        // 另外六份仅把 `v${version}` 当标签写进日志、从不核验)。
        'process.env.GITHUB_REF === expectedRef',
        "['pm', 'pack', '--destination', packDirectory, '--ignore-scripts']",
        'sourceSha,',
        'fileName: tarballs[0]',
        'sizeBytes:',
        "sha256: createHash('sha256')",
        "'publish',\n      tarballPath,",
      ],
    },
  ]

  for (const contract of contracts) {
    const contractPath = resolve(RepoRoot, contract.file)
    if (!existsSync(contractPath)) {
      violations.push({
        rule: 'release-artifact-identity',
        fingerprint: `release-artifact-identity::missing::${contract.file}`,
        message: `${contract.file}: 发布身份门文件缺失。`,
      })
      continue
    }
    const source = readFileSync(contractPath, 'utf8')
    const missing = contract.markers.filter((marker) => !source.includes(marker))
    if (missing.length === 0) continue
    violations.push({
      rule: 'release-artifact-identity',
      fingerprint: `release-artifact-identity::${contract.file}`,
      message: `${contract.file}: 发布链缺失精确 source/ref/tag/tarball 身份门,缺失=${missing.join(', ')}。`,
    })
  }
  return violations
}

function loadBaseline() {
  if (!existsSync(BaselinePath)) return new Set()
  const parsed = JSON.parse(readFileSync(BaselinePath, 'utf8'))
  return new Set(parsed.fingerprints ?? [])
}

function main() {
  const violations = [
    ...scanPackageSet(),
    ...scanHostNeutrality(),
    ...scanDependencyDirection(),
    ...scanProtocolSingleSource(),
    ...scanApprovalPort(),
    ...scanConcreteCapabilityDirection(),
    ...scanReleaseIdentityBoundary(),
  ]
  const currentFingerprints = violations.map((v) => v.fingerprint).sort()

  if (UpdateBaseline) {
    writeFileSync(
      BaselinePath,
      `${JSON.stringify(
        {
          version: 2,
          purpose:
            'Kernel 三包边界(package set + host neutrality + dependency direction + protocol single source + approval port + concrete capability injection + release identity);基线必须保持零。',
          generatedAt: new Date().toISOString(),
          fingerprints: currentFingerprints,
        },
        null,
        2,
      )}\n`,
    )
    console.log(`[arch-boundaries] baseline 已重生成:${currentFingerprints.length} 条冻结指纹。`)
    return
  }

  const baseline = loadBaseline()
  const fresh = violations.filter((v) => !baseline.has(v.fingerprint))
  if (fresh.length === 0) {
    const exempt = currentFingerprints.length
    console.log(
      `[arch-boundaries] 通过。包集合 + host 无关 + 依赖方向 + 协议单一事实来源 + 审批端口 + 能力注入 + 发布身份:0 条新违规${
        exempt > 0 ? `(${exempt} 条存量入基线冻结)` : '(现状零违规)'
      }。`,
    )
    return
  }

  console.error(`[arch-boundaries] 失败:${fresh.length} 条新违规(基线只减不增):`)
  for (const v of fresh) console.error(`  [${v.rule}] ${v.message}`)
  console.error(
    '\n若为有意的架构变化,修复违规;确需入基线时 VELAROS_ARCH_BASELINE_UPDATE=1 bun scripts/check-arch-boundaries.mjs 重生成并在提交信息说明。',
  )
  process.exit(1)
}

main()
