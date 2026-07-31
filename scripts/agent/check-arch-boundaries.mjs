#!/usr/bin/env bun
// 用途:Agent 单包架构边界哨兵。@velaros-ai/agent(主干 runtime + ./protocol 线协议切片)是可注入的
// Agent 能力；具体能力必须在仓外注入。
//
// 七道防线(基线=零违规):
//  ① Agent 包必须 host 无关——禁 import electron / @electron/* / Desktop 传输 @velaros-ai/ipc /
//     renderer·main 别名(@components|@features|@hooks|@pages|@styles|@shared|@/|@preload|@main)。
//  ② 审批端口教义(源 velaros/require-approval-port-for-confirmation,宪章 §4 ApprovalPort 默认 deny):
//     审批动词 awaitConfirmation / awaitConfirmationDecision 必须经 ctx.approval.*;写在 ctx.execution
//     接收面(含 `!`/`?.`)上即报——execution 为空的宿主上会崩溃或 fail-open 放行敏感操作。
//  ③ 全包禁止反向 import 任何具体能力实现。
//  ④ Agent turn 能力快照:Solo/Query 每轮必须在首个异步准备动作前捕获一次工具注册表，
//     provider request 与执行策略必须消费同一份 turnToolRegistry。
//  ⑤ 领域语义与观测语义必须由 capability 注入。
//  ⑥ 发布必须绑定精确 source/ref/tag 和同一已验明 tarball。
//
// 有意的基线变化:VELAROS_ARCH_BASELINE_UPDATE=1 bun scripts/check-arch-boundaries.mjs 重生成基线,
// 并在提交信息里说明差异。
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(HERE, '../..')
const BaselinePath = join(RepoRoot, 'baselines', 'agent', 'arch-boundaries-baseline.json')
const UpdateBaseline = process.env.VELAROS_ARCH_BASELINE_UPDATE === '1'

const SourceExtensions = new Set(['.ts', '.tsx'])

// Agent 簇包(相对仓根的 package 目录);均须 host 无关、零 Electron。
// core / kernel-* 不在本仓(已拆出为注册表依赖),其边界棘轮由各自仓自持,不并入本表。
const KernelClusterPackages = ['packages/agent']

const MinimalKernelPackages = ['packages/agent']

// 禁止的 host 耦合 import。每个分支都以闭合引号收尾,避免误伤 `electron-store` 之类前缀同形的包名。
const ForbiddenHostImportPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"](?:electron(?:\/[^'"]*)?|@electron\/[^'"]*|@velaros\/ipc(?:\/[^'"]*)?|@(?:components|features|hooks|pages|styles|shared)\/[^'"]*|@\/[^'"]*|@preload|@main\/[^'"]*)['"]/

// 审批动词写在 ctx.execution 接收面上的旁路形态(局部 `execution` 变量的合法读取面不匹配)。
const ApprovalVerbOnExecutionPattern =
  /(?<![A-Za-z0-9_$.])(?:this\.)?ctx\.execution(?![A-Za-z0-9_$])\s*[!?]?\s*\.\s*(awaitConfirmation(?:Decision)?)\b/

const ConcreteCapabilityImportPattern =
  /(?:from\s+|import\s*\(|require\()\s*['"]@velaros-ai\/(?:model|workspace|computer|system-tools|office-tools|browser|memory)(?:\/[^'"]*)?['"]/

function normalizeSeparators(pathText) {
  return pathText.split('\\').join('/')
}

function collectSourceFiles(dir) {
  const out = []
  if (!existsSync(dir)) return out
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'out' || entry === 'build') continue
    const full = join(dir, entry)
    const stats = statSync(full)
    if (stats.isDirectory()) {
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
  let state = 'code' // code | line | block | single | double | template
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
      // 字符串/模板字面量:原样保留,处理转义与闭合。
      result += ch
      if (ch === '\\') {
        result += source[i + 1] ?? ''
        i += 1
      } else if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`')
      ) {
        state = 'code'
      }
    }
  }
  return result
}

// —— 防线① kernel 簇 import 方向边界 ——
function scanKernelClusterBoundary() {
  const violations = []
  for (const packageDir of KernelClusterPackages) {
    const sourceDir = resolve(RepoRoot, packageDir, 'src')
    if (!existsSync(sourceDir)) continue
    for (const file of collectSourceFiles(sourceDir)) {
      const relativeFile = normalizeSeparators(relative(RepoRoot, file))
      const lines = stripCodeComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (!ForbiddenHostImportPattern.test(line)) return
        violations.push({
          rule: 'kernel-cluster-boundary',
          fingerprint: `kernel-cluster-boundary::${relativeFile}:${index + 1}`,
          message: `${relativeFile}:${index + 1}: Agent 簇必须 host 无关,禁止 import electron/@electron 或 Desktop 传输与 renderer/main 路径。`,
        })
      })
    }
  }
  return violations
}

// —— 防线② 审批端口教义 ——
function scanApprovalPort() {
  const violations = []
  const sourceDirs = KernelClusterPackages.map((pkg) => resolve(RepoRoot, pkg, 'src'))
  for (const sourceDir of sourceDirs) {
    if (!existsSync(sourceDir)) continue
    for (const file of collectSourceFiles(sourceDir)) {
      const relativeFile = normalizeSeparators(relative(RepoRoot, file))
      const lines = stripCodeComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        const match = ApprovalVerbOnExecutionPattern.exec(line)
        if (!match) return
        const verb = match[1]
        violations.push({
          rule: 'require-approval-port',
          fingerprint: `require-approval-port::${relativeFile}:${index + 1}::${verb}`,
          message: `${relativeFile}:${index + 1}: 审批动词 \`${verb}\` 写在 \`ctx.execution\` 接收面上;审批必须经 \`ctx.approval.${verb}(...)\`(宪章 §4 ApprovalPort 默认 deny)。`,
        })
      })
    }
  }
  return violations
}

// —— 防线③ 微内核不得依赖具体能力实现 ——
function scanMinimalKernelDependencyDirection() {
  const violations = []
  for (const packageDir of MinimalKernelPackages) {
    const manifestPath = resolve(RepoRoot, packageDir, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    for (const sectionName of [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]) {
      for (const dependencyName of Object.keys(manifest[sectionName] ?? {})) {
        if (!ConcreteCapabilityImportPattern.test(`from '${dependencyName}'`)) continue
        violations.push({
          rule: 'kernel-concrete-capability-dependency',
          fingerprint: `kernel-concrete-capability-dependency::${packageDir}/package.json::${sectionName}::${dependencyName}`,
          message: `${packageDir}/package.json: Agent 两包不得在 ${sectionName} 声明具体能力 ${dependencyName}。`,
        })
      }
    }

    const sourceDir = resolve(RepoRoot, packageDir, 'src')
    if (!existsSync(sourceDir)) continue
    for (const file of collectSourceFiles(sourceDir)) {
      const relativeFile = normalizeSeparators(relative(RepoRoot, file))
      const lines = stripCodeComments(readFileSync(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (!ConcreteCapabilityImportPattern.test(line)) return
        violations.push({
          rule: 'minimal-kernel-dependency-direction',
          fingerprint: `minimal-kernel-dependency-direction::${relativeFile}:${index + 1}`,
          message: `${relativeFile}:${index + 1}: Agent 两包不得 import 具体能力实现；请由能力包反向依赖 Agent 并在产品装配根注入。`,
        })
      })
    }
  }
  return violations
}

// —— 防线④ Agent turn 的工具能力必须在 provider 请求前冻结 ——
function scanAgentTurnCapabilitySnapshotBoundary() {
  const violations = []
  const contracts = [
    {
      file: 'packages/agent/src/agent/SoloLoop.ts',
      orderedMarkers: [
        'const turnToolRegistry = captureAgentTurnCapabilitySnapshot(this.toolRegistry)',
        'const resolvedRoleRuntime = await this.runtimeHelper.resolveRoleRuntime(',
      ],
      requiredMarkers: [
        'const turnExecutionPolicy = new ToolExecutionPolicy(turnToolRegistry)',
        'toolRegistry: turnToolRegistry',
      ],
    },
    {
      file: 'packages/agent/src/agent/SoloRunPlanPreparer.ts',
      orderedMarkers: [],
      requiredMarkers: ['capabilityRevision: input.toolRegistry.getCapabilityRevision?.()'],
    },
    {
      file: 'packages/agent/src/agent/QueryLoop.ts',
      orderedMarkers: [
        'const turnToolRegistry = captureAgentTurnCapabilitySnapshot(this.toolRegistry)',
        'const { systemPrompt } = await this.runContextHelper.buildSystemPrompt({',
      ],
      requiredMarkers: [
        'const turnToolContext = captureAgentTurnCapabilityContext(childCtx)',
        'toolRegistry: turnToolRegistry',
      ],
    },
    {
      file: 'packages/agent/src/tools/ExecutionPolicy.ts',
      orderedMarkers: [],
      requiredMarkers: ['this.toolRegistry.getCurrentRegistrationSignature'],
    },
  ]

  for (const contract of contracts) {
    const source = readFileSync(resolve(RepoRoot, contract.file), 'utf8')
    const missing = contract.requiredMarkers.filter((marker) => !source.includes(marker))
    const ordered =
      contract.orderedMarkers.length < 2 ||
      contract.orderedMarkers.every((marker, index) => {
        if (index === 0) return source.indexOf(marker) >= 0
        return source.indexOf(marker) > source.indexOf(contract.orderedMarkers[index - 1])
      })
    if (missing.length === 0 && ordered) continue

    violations.push({
      rule: 'agent-turn-capability-snapshot-boundary',
      fingerprint: `agent-turn-capability-snapshot-boundary::${contract.file}`,
      message: `${contract.file}: 每个 logical provider turn 必须先捕获工具能力快照，并让 provider request / ExecutionPolicy 共用该快照；缺失=${missing.join(',') || 'ordered-capture'}。`,
    })
  }
  return violations
}

// —— 防线⑤ 领域语义只由能力扩展注入，不得回流到 Core / Agent 中立执行主链 ——
function scanConcreteSemanticInjectionBoundary() {
  const violations = []
  const forbiddenConcreteFiles = [
    'packages/agent/src/agent/run-context/BrowserActionPolicy.ts',
    'packages/agent/src/agent/runner/WorkbenchEditorControlPolicy.ts',
    'packages/agent/src/team/model-selection.ts',
    'packages/agent/src/prompts/segments/browser.ts',
    'packages/agent/src/prompts/segments/workspace.ts',
    'packages/agent/src/tools/BrowserTargetActionRecovery.ts',
    'packages/agent/src/tools/BrowserToolResultEnhancer.ts',
    'packages/agent/src/agent/runner/RunnerSandbox.ts',
    'packages/agent/src/tool-library/WorkspaceCapabilityPort.ts',
    'packages/agent/src/agent/CodingContext.ts',
    'packages/agent/src/agent/CodingContextPolicy.ts',
    'packages/agent/src/reminders/producers.ts',
    'packages/agent/src/reminders/renderers.ts',
  ]
  for (const file of forbiddenConcreteFiles) {
    if (!existsSync(resolve(RepoRoot, file))) continue
    violations.push({
      rule: 'concrete-semantic-file',
      fingerprint: `concrete-semantic-file::${file}`,
      message: `${file}: 具体产品/能力策略不得回流 Agent；请由能力包通过 AgentRuntimeCapabilityPorts 注入。`,
    })
  }

  const neutralPolicyFiles = [
    'packages/agent/src/agent/control-plane/SessionToolAllocator.ts',
    'packages/agent/src/tools/ToolArgsSchemaValidator.ts',
  ]
  const concreteLiteralPattern =
    /['"`][^'"`\n]*(?:browser|workspace|workbench|memory|knowledge|office|computer|model)[_-][a-z0-9_-]+[^'"`\n]*['"`]/iu
  for (const file of neutralPolicyFiles) {
    const source = stripCodeComments(readFileSync(resolve(RepoRoot, file), 'utf8'))
    const lines = source.split('\n')
    lines.forEach((line, index) => {
      if (!concreteLiteralPattern.test(line)) return
      violations.push({
        rule: 'concrete-semantic-literal',
        fingerprint: `concrete-semantic-literal::${file}:${index + 1}`,
        message: `${file}:${index + 1}: 中立策略层不得硬编码领域工具/操作名；请放入 capability descriptor/provider。`,
      })
    })
  }

  const forbiddenSemanticSymbols = [
    'BrowserElementSelection',
    'WorkspaceKernelToolNames',
    'workspaceSpaces',
    'isProjectWorkspaceRootSource',
    'CodingVerificationFailure',
    'ToolWorkspaceSandboxApi',
    'RunnerToolWorkspaceSandboxApi',
    'ChatProviderId',
    'AgentProviderAdapterConfig',
    'ProviderModelCatalog',
    'KnowledgeSearchResult',
    'WorkspaceRootService',
    'ComputerRuntimePort',
    'RunnerWorkspace',
    'workspaceSandbox',
    'AgentSurfaceRegistry',
  ]
  for (const packageDir of ['packages/agent']) {
    const sourceDir = resolve(RepoRoot, packageDir, 'src')
    for (const file of collectSourceFiles(sourceDir)) {
      const relativeFile = normalizeSeparators(relative(RepoRoot, file))
      const source = stripCodeComments(readFileSync(file, 'utf8'))
      for (const symbol of forbiddenSemanticSymbols) {
        const match = new RegExp(`\\b${symbol}\\b`, 'u').exec(source)
        if (!match) continue
        const line = source.slice(0, match.index).split('\n').length
        violations.push({
          rule: 'forbidden-concrete-semantic-symbol',
          fingerprint: `forbidden-concrete-semantic-symbol::${relativeFile}:${line}::${symbol}`,
          message: `${relativeFile}:${line}: ${symbol} 是具体能力/产品语义，必须由产品组合根或能力包注入。`,
        })
      }
    }
  }

  const concreteRuntimeLiteralPattern =
    /['"`][^'"`\n]*(?:browser|workspace|workbench|memory|knowledge|computer)[_:-][a-z0-9_-]+[^'"`\n]*['"`]/iu
  const agentRuntimeSourceDir = resolve(RepoRoot, 'packages/agent/src')
  for (const file of collectSourceFiles(agentRuntimeSourceDir)) {
    const relativeFile = normalizeSeparators(relative(RepoRoot, file))
    const lines = stripCodeComments(readFileSync(file, 'utf8')).split('\n')
    lines.forEach((line, index) => {
      if (!concreteRuntimeLiteralPattern.test(line)) return
      violations.push({
        rule: 'agent-runtime-concrete-semantic-literal',
        fingerprint: `agent-runtime-concrete-semantic-literal::${relativeFile}:${index + 1}`,
        message: `${relativeFile}:${index + 1}: Agent Runtime 不得硬编码具体能力 id、工具名或隔离原因。`,
      })
    })
  }

  const concreteSemanticVocabularyPattern =
    /\b(?:browser|workspace|workbench|memory|knowledge|computer)\b|工作区|浏览器|记忆/iu
  for (const file of collectSourceFiles(agentRuntimeSourceDir)) {
    const relativeFile = normalizeSeparators(relative(RepoRoot, file))
    const source = readFileSync(file, 'utf8')
    const match = concreteSemanticVocabularyPattern.exec(source)
    if (!match) continue
    const line = source.slice(0, match.index).split('\n').length
    violations.push({
      rule: 'agent-runtime-concrete-semantic-vocabulary',
      fingerprint: `agent-runtime-concrete-semantic-vocabulary::${relativeFile}:${line}`,
      message: `${relativeFile}:${line}: Agent Runtime 的代码、文案和注释都不得解释具体产品能力；请使用 capability/resource/scope 中立术语。`,
    })
  }

  const requiredInjectionMarkers = [
    {
      file: 'packages/agent/src/tools/Executor.ts',
      markers: ['resolveToolResultMiddlewares(this.ctx.capabilityPorts)'],
    },
    {
      file: 'packages/agent/src/tools/ExecutionPolicy.ts',
      markers: ['resolveToolValidationHintProviders(', 'capabilityPorts?: AgentRuntimeCapabilityPorts'],
    },
    {
      file: 'packages/agent/src/agent/control-plane/SessionToolAllocator.ts',
      markers: ['resolveToolAllocationMetadata(options.capabilityPorts)'],
    },
    {
      file: 'packages/agent/src/agent/PromptState.ts',
      markers: ['resolveCapabilityPromptSegments(toolContext.capabilityPorts, runtimeSnapshot)'],
    },
    {
      file: 'packages/agent/src/team/model-router.ts',
      markers: ['constructor(private readonly routing: TeamModelRoutingPort)'],
    },
    {
      file: 'packages/agent/src/agent/runner/AgentRunner.ts',
      markers: ['surfaceProfileProvider: AgentSurfaceProfileProvider'],
    },
    {
      file: 'packages/agent/src/agent/QueryLoop.ts',
      markers: ['resolveCapabilityDelegationPolicy(args.parentCtx.capabilityPorts)'],
    },
    {
      file: 'packages/agent/src/kernel/dispatch/SubAgentDispatcher.ts',
      markers: ['resolveCapabilityDelegationPolicy(this.capabilityPorts)'],
    },
    {
      file: 'packages/agent/src/protocol/external-agent-bridge.ts',
      markers: [
        'ExternalAgentBridgeProtocolDescriptor',
        'transportVersion: ExternalAgentBridgeProtocolVersion',
      ],
    },
    {
      file: 'packages/agent/src/protocol/observability.ts',
      markers: [
        'CapabilitySpanSchema',
        "category: z.literal('capability')",
        'operationId: z.string().min(1)',
        'metadata: z.record(z.string(), z.unknown())',
      ],
    },
    {
      file: 'packages/agent/src/kernel/observability/execution-span-scope.ts',
      markers: ['recordCapabilitySpan(', 'ExecutionCapabilitySpanRecorder'],
    },
  ]
  for (const contract of requiredInjectionMarkers) {
    const source = readFileSync(resolve(RepoRoot, contract.file), 'utf8')
    const missing = contract.markers.filter((marker) => !source.includes(marker))
    if (missing.length === 0) continue
    violations.push({
      rule: 'capability-injection-wiring',
      fingerprint: `capability-injection-wiring::${contract.file}`,
      message: `${contract.file}: 能力注入主链缺失 ${missing.join(', ')}。`,
    })
  }

  const neutralObservabilityFiles = [
    'packages/agent/src/protocol/observability.ts',
    'packages/agent/src/kernel/observability/execution-span-debug.ts',
    'packages/agent/src/kernel/observability/execution-span-scope.ts',
    'packages/agent/src/kernel/observability/index.ts',
  ]
  const retiredConcreteObservationPattern =
    /\b(?:MemorySpan(?:Schema)?|ExecutionSpanDebugMemory|recordMemorySpan|recordAttentionOutcomeMirror|ExecutionSpanOutcomeMirror)\b|category:\s*z\.literal\(['"]memory['"]\)|category\s*===\s*['"]memory['"]/u
  for (const file of neutralObservabilityFiles) {
    const source = stripCodeComments(readFileSync(resolve(RepoRoot, file), 'utf8'))
    const match = retiredConcreteObservationPattern.exec(source)
    if (!match) continue
    const line = source.slice(0, match.index).split('\n').length
    violations.push({
      rule: 'concrete-observability-semantic',
      fingerprint: `concrete-observability-semantic::${file}:${line}`,
      message: `${file}:${line}: Agent 观测协议只能记录通用 capability/context 元数据，不得重新定义 Memory 具体语义。`,
    })
  }
  return violations
}

// —— 防线⑥ 发布必须绑定精确源码身份并发布已验明的同一 tarball ——
//
// 2026-08 合并:并仓前每域各核验自己那套 scripts/<domain>/release/*(七份功能等价的副本),
// 现在全域共用 scripts/release/ 一条链,故契约指向那一份。**核验的语义一条没减,反而多两条**:
// ① 旧 workflow 没有 publish 步骤,「发布链存在」当时无法机械断言,现在漏接 publish 即红;
// ② 发布器必须自己核验运行时 ref 就是那个 tag(并仓前只有 model 那份这么做)。
// 门与 kernel 域那份刻意**不共享代码**:每域独立按字面标记核对,一域的门被改弱不会连带放过其它域
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
    // 文件缺失要报成违规,不能让 readFileSync 抛 ENOENT 把整个门炸成崩溃——崩溃的门读不出
    // 「缺了什么」,而删掉发布脚本恰恰是最需要被清楚拦下的那种改动(kernel 域那份一直有此分支)。
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
      message: `${contract.file}: 发布链缺失精确 source/ref/tag/tarball 身份门，缺失=${missing.join(', ')}。`,
    })
  }
  return violations
}

function loadBaseline() {
  if (!existsSync(BaselinePath)) return new Set()
  const parsed = JSON.parse(readFileSync(BaselinePath, 'utf8'))
  return new Set(parsed.fingerprints ?? [])
}

// VelarOS-Platform 单版本火车:packages/ 是全平台包的公共家,冻结面从「整个 packages/」收敛为
// 「Agent 域的包集合」。域包清单单源 = 仓根 package.json 的 velaros.domainPackages.agent;
// 两处必须一致,新增 Agent 包要同时登记 KernelClusterPackages 与该清单,漏登即红。
const DomainPackageDirectories =
  JSON.parse(readFileSync(join(RepoRoot, 'package.json'), 'utf8')).velaros
    ?.domainPackages?.agent ?? []

function scanAgentPackageSet() {
  const owned = new Set(KernelClusterPackages.map((path) => path.split('/').at(-1)))
  const registered = new Set(DomainPackageDirectories)
  const actual = readdirSync(resolve(RepoRoot, 'packages'), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    // 只看本域:已登记的,加上任何未登记却自称 agent-* 的偷渡包。
    .filter((name) => registered.has(name) || /^agent-/u.test(name))
    .sort()
  const unregistered = [...owned].filter((name) => !registered.has(name))
  const unexpected = [
    ...actual.filter((name) => !owned.has(name)),
    ...unregistered.map((name) => `${name}(未登记进仓根 velaros.domainPackages.agent)`),
  ]
  const missing = [...owned].filter((name) => !actual.includes(name))
  const violations = []
  if (unexpected.length > 0) {
    violations.push({
      rule: 'agent-package-set',
      fingerprint: `agent-package-set::unexpected::${unexpected.join(',')}`,
      message: `Agent 仓包含非 Agent 包:${unexpected.join(', ')}。`,
    })
  }
  if (missing.length > 0) {
    violations.push({
      rule: 'agent-package-set',
      fingerprint: `agent-package-set::missing::${missing.join(',')}`,
      message: `Agent 两包缺失:${missing.join(', ')}。`,
    })
  }
  return violations
}

function main() {
  const violations = [
    ...scanAgentPackageSet(),
    ...scanKernelClusterBoundary(),
    ...scanApprovalPort(),
    ...scanMinimalKernelDependencyDirection(),
    ...scanAgentTurnCapabilitySnapshotBoundary(),
    ...scanConcreteSemanticInjectionBoundary(),
    ...scanReleaseIdentityBoundary(),
  ]
  const currentFingerprints = violations.map((v) => v.fingerprint).sort()

  if (UpdateBaseline) {
    writeFileSync(
      BaselinePath,
      `${JSON.stringify(
        {
          version: 1,
          purpose:
            'Agent 两包边界(package set + host boundary + approval port + concrete capability injection + turn capability snapshot + semantic injection);基线必须保持零。',
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
      `[arch-boundaries] 通过。Agent 包集合 + host import + 审批端口 + 具体能力注入 + Agent turn 能力快照 + 领域语义注入:0 条新违规${
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
