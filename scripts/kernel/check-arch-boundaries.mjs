#!/usr/bin/env bun
// 用途:Kernel 架构边界哨兵。基线=零违规。
//
// Kernel 域只占一个包,用子路径表达职责,不再用多个平铺包表达内部切片:
//   packages/kernel/src/contracts  ABI、wire protocol、service contracts
//   packages/kernel/src/runtime    进程内 Kernel runtime
//   packages/kernel/src/client     serve 模式的瘦客户端
//   packages/kernel/src/serve      可选 daemon / RPC / updater 部署组合
//
// 八道防线:
//  ① 包集合冻结:Kernel 域只能有 packages/kernel 一个包。
//  ② host 无关:整个 Kernel 禁 import Electron / Desktop renderer/main 路径。
//  ③ 依赖方向:core → kernel 禁止;contracts → runtime/client/serve 禁止;
//     runtime → client/serve 禁止;client → runtime/serve 禁止;updater 不得触达其它切片。
//  ④ 协议单一事实来源:wire schema 只能定义在 packages/kernel/src/contracts/protocol。
//  ⑤ 审批端口教义(宪章 §4 ApprovalPort 默认 deny):审批动词必须经 ctx.approval.*。
//  ⑥ Kernel 不得依赖任何具体能力实现(browser / workspace / memory / model 等由产品装配根注入)。
//  ⑦ 发布必须绑定精确 source/ref/tag 和同一已验明 tarball。
//  ⑧ 单内核运行语义:new Kernel / serve 共用一条 capability invoker;module ABI 版本只认常量。
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

/** Kernel 域唯一包。职责通过公开 subpath 切片表达。 */
const PublicPackages = ['kernel']

/** updater 子路径相对 import 触达 daemon 切片即违规。 */
const UpdaterReachesDaemonPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"]\.{1,2}(?:\/\.\.)*\/daemon(?:\/[^'"]*)?['"]/

/** Kernel 唯一源码根。 */
const KernelLibraryRoot = 'packages/kernel/src'

/** 需要 host 无关的全部源码根。 */
const HostNeutralRoots = [KernelLibraryRoot]

const ForbiddenHostImportPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*|@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/

const ApprovalVerbOnExecutionPattern =
  /(?<![A-Za-z0-9_$.])(?:this\.)?ctx\.execution(?![A-Za-z0-9_$])\s*[!?]?\s*\.\s*(awaitConfirmation(?:Decision)?)\b/

const ConcreteCapabilityImportPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"]@velaros-ai\/(?:model|project|development|computer|system|office|browser|memory|agent)(?:\/[^'"]*)?['"]/

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
    // 只看本域:已登记的,加上任何未登记却自称 kernel / kernel-* 的偷渡包。
    .filter((name) => registered.has(name) || /^kernel(?:-|$)/u.test(name))
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
      message: `Kernel 域只应包含 packages/kernel,发现额外包:${unexpected.join(', ')}。内部职责请收进 @velaros-ai/kernel 子路径。`,
    })
  }
  if (missing.length > 0) {
    violations.push({
      rule: 'kernel-package-set',
      fingerprint: `kernel-package-set::missing::${missing.join(',')}`,
      message: `Kernel 域唯一包缺失:${missing.join(', ')}。`,
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

  // Core 是无领域语义的共享 primitives,Kernel 只能单向依赖 Core。
  violations.push(
    ...scanLines(
      ['packages/core/src'],
      (line) => importsPackage(line, ['@velaros-ai/kernel']),
      (file, line) => ({
        rule: 'core-kernel-independence',
        fingerprint: `core-kernel-independence::${file}:${line}`,
        message: `${file}:${line}: Core 是共享 primitives,不得依赖 Kernel。`,
      }),
    ),
  )

  // contracts 是最内层稳定面,不得认识实现或部署切片。
  violations.push(
    ...scanLines(
      ['packages/kernel/src/contracts'],
      (line) =>
        InternalImplementationPattern.test(line)
        || importsPackage(line, [
          '@velaros-ai/kernel/runtime',
          '@velaros-ai/kernel/client',
          '@velaros-ai/kernel/serve',
        ])
        || /(?:from\s+|import\s*\(|require\()\s*['"]\.\.(?:\/\.\.)*\/(?:runtime|client|serve)(?:\/[^'"]*)?['"]/.test(line),
      (file, line) => ({
        rule: 'contracts-dependency-direction',
        fingerprint: `contracts-dependency-direction::${file}:${line}`,
        message: `${file}:${line}: Kernel contracts 不得依赖 runtime、client 或 serve。`,
      }),
    ),
  )

  // runtime 是库形态实现,不得反向依赖接入与部署组合。
  violations.push(
    ...scanLines(
      ['packages/kernel/src/runtime'],
      (line) =>
        importsPackage(line, ['@velaros-ai/kernel/client', '@velaros-ai/kernel/serve'])
        || /(?:from\s+|import\s*\(|require\()\s*['"]\.\.(?:\/\.\.)*\/(?:client|serve)(?:\/[^'"]*)?['"]/.test(line),
      (file, line) => ({
        rule: 'runtime-dependency-direction',
        fingerprint: `runtime-dependency-direction::${file}:${line}`,
        message: `${file}:${line}: Kernel runtime 不得依赖 client 或 serve。`,
      }),
    ),
  )

  // client 只依赖 contracts;不能绕回 runtime 或 serve 实现。
  violations.push(
    ...scanLines(
      ['packages/kernel/src/client'],
      (line) =>
        importsPackage(line, ['@velaros-ai/kernel/runtime', '@velaros-ai/kernel/serve'])
        || /(?:from\s+|import\s*\(|require\()\s*['"]\.\.(?:\/\.\.)*\/(?:runtime|serve)(?:\/[^'"]*)?['"]/.test(line),
      (file, line) => ({
        rule: 'client-dependency-direction',
        fingerprint: `client-dependency-direction::${file}:${line}`,
        message: `${file}:${line}: Kernel client 只能依赖 contracts,不得依赖 runtime 或 serve。`,
      }),
    ),
  )

  // updater 只负责字节、签名与版本指针,不得触达 daemon/client/runtime。
  violations.push(
    ...scanLines(
      ['packages/kernel/src/serve/updater'],
      (line) =>
        UpdaterReachesDaemonPattern.test(line)
        || importsPackage(line, [
          '@velaros-ai/kernel/runtime',
          '@velaros-ai/kernel/client',
          '@velaros-ai/kernel/contracts',
          '@velaros-ai/kernel/serve',
        ])
        || /(?:from\s+|import\s*\(|require\()\s*['"]\.\.(?:\/\.\.)*\/(?:client|contracts|runtime|daemon|rpc|internal)(?:\/[^'"]*)?['"]/.test(line),
      (file, line) => ({
        rule: 'updater-dependency-direction',
        fingerprint: `updater-dependency-direction::${file}:${line}`,
        message: `${file}:${line}: Kernel updater 不得依赖 contracts、runtime、client 或其它 serve 切片。`,
      }),
    ),
  )

  // package.json 层面的 Core 反向依赖同样是违规。
  const manifestBans = { core: ['@velaros-ai/kernel'] }
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

  const protocolHome = resolve(RepoRoot, KernelLibraryRoot, 'contracts', 'protocol')
  if (!existsSync(protocolHome)) {
    violations.push({
      rule: 'protocol-single-source',
      fingerprint: 'protocol-single-source::missing-home',
      message: `wire 协议实现目录 ${KernelLibraryRoot}/contracts/protocol 不存在;协议必须有唯一实现处。`,
    })
    return violations
  }

  // 协议 zod schema 只能定义在唯一实现处;别处重新定义 wire schema 即为复制协议。
  const wireSchemaDefinition = /export\s+const\s+\w*(?:Handshake|CapabilityCall|ModuleDescriptor|ScopeRef|ResourceRef|CapabilityToken)\w*Schema\s*=/
  for (const file of collectSourceFiles(resolve(RepoRoot, KernelLibraryRoot))) {
    if (file.startsWith(`${protocolHome}/`)) continue
    const relativeFile = normalizeSeparators(relative(RepoRoot, file))
    const lines = stripCodeComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      if (!wireSchemaDefinition.test(line)) return
      violations.push({
        rule: 'protocol-single-source',
        fingerprint: `protocol-single-source::duplicate::${relativeFile}:${index + 1}`,
        message: `${relativeFile}:${index + 1}: wire schema 只能定义在 ${KernelLibraryRoot}/contracts/protocol。`,
      })
    })
  }

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
// The Kernel gate independently verifies the canonical release workflow, source identity,
// and tarball publication markers. This deliberate redundancy prevents a weakened release
// helper from weakening its own verifier at the same time.
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
        // tag 方案 2026-08-02 从「只认 v<火车号>」扩成「整列 v<火车号> 或 单包 <名>@<版本>」,
        // 判据随之从字面比对搬进 resolveReleaseSelection(单源)。核验的语义没减:仍要求
        // 事件合法、ref 是 tag、ref 与 refName 互相印证、且 tag 能解析出确定的发布范围。
        'resolveReleaseSelection(rootManifest, ordered, refName)',
        "!['push', 'workflow_dispatch'].includes(eventName)",
        "refType !== 'tag'",
        'ref !== `refs/tags/${refName}`',
        "selection.kind === 'unknown'",
      ],
    },
    {
      file: 'scripts/release/publish-packages.mjs',
      markers: [
        "runForOutput('git', ['rev-parse', 'HEAD'], root)",
        "['status', '--porcelain', '--untracked-files=all']",
        // The publisher must verify that the runtime ref is the selected tag.
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

// —— 防线⑧ 进程内 / serve 共用一条运行语义 ——
function scanRuntimeSinglePath() {
  const violations = []
  const packageSourceRoots = readdirSync(resolve(RepoRoot, 'packages'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/${entry.name}/src`)
  const allowedHostConstructors = new Set([
    'packages/kernel/src/runtime/Kernel.ts',
    'packages/kernel/src/serve/daemon/boot.ts',
  ])

  for (const file of collectSourceFiles(resolve(RepoRoot, KernelLibraryRoot))) {
    const relativeFile = normalizeSeparators(relative(RepoRoot, file))
    const source = stripCodeComments(readFileSync(file, 'utf8'))
    if (
      /new\s+KernelModuleHost\s*\(/u.test(source)
      && !allowedHostConstructors.has(relativeFile)
    ) {
      violations.push({
        rule: 'kernel-runtime-single-path',
        fingerprint: `kernel-runtime-single-path::host-constructor::${relativeFile}`,
        message: `${relativeFile}: KernelModuleHost 只能由公共 Kernel 或 serve 组合根构造。`,
      })
    }
  }

  const sharedInvocationContracts = [
    {
      file: 'packages/kernel/src/runtime/Kernel.ts',
      marker: 'new KernelCapabilityInvoker(this.host)',
    },
    {
      file: 'packages/kernel/src/runtime/service/KernelService.ts',
      marker: 'new KernelCapabilityInvoker(options.host)',
    },
  ]
  for (const contract of sharedInvocationContracts) {
    const source = readFileSync(resolve(RepoRoot, contract.file), 'utf8')
    if (source.includes(contract.marker)) continue
    violations.push({
      rule: 'kernel-runtime-single-path',
      fingerprint: `kernel-runtime-single-path::missing-invoker::${contract.file}`,
      message: `${contract.file}: 进程内与 serve 调用面必须复用 KernelCapabilityInvoker。`,
    })
  }

  violations.push(
    ...scanLines(
      packageSourceRoots,
      (line) => /\bapiVersion\s*:\s*1\b/u.test(line),
      (file, line) => ({
        rule: 'kernel-module-api-version-single-source',
        fingerprint: `kernel-module-api-version-single-source::${file}:${line}`,
        message: `${file}:${line}: module apiVersion 必须引用 KernelModuleApiVersion,禁止复制数字版本。`,
      }),
    ),
  )

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
    ...scanRuntimeSinglePath(),
  ]
  const currentFingerprints = violations.map((v) => v.fingerprint).sort()

  if (UpdateBaseline) {
    writeFileSync(
      BaselinePath,
      `${JSON.stringify(
        {
          version: 2,
          purpose:
            'Kernel 单包子路径边界(package set + host neutrality + dependency direction + protocol single source + approval port + concrete capability injection + release identity + runtime single path);基线必须保持零。',
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
      `[arch-boundaries] 通过。包集合 + host 无关 + 依赖方向 + 协议单一事实来源 + 审批端口 + 能力注入 + 发布身份 + 单内核运行语义:0 条新违规${
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
