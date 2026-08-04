#!/usr/bin/env bun
// 用途:Agent workflow 的 schema 与纯 IR contract 检查。
//
// 三道防线:
//  ① Agent workflow input schema 不得退化为零参数；
//  ② workflow IR 解释器无宿主能力；
//  ③ 纯 IR contract 稳定。
// wire protocol 快照基线归 Kernel 仓自持(kernel-protocol 不在本仓)。
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { AgentWorkflowRuntime,agentWorkflowSchema } from '@velaros-ai/agent'
import { createToolSchemaBundle } from '@velaros-ai/agent/tool-contract'

const HERE = dirname(fileURLToPath(import.meta.url))
const RepoRoot = resolve(HERE, '../..')
const WorkflowRuntimePath = join(
  RepoRoot,
  'packages',
  'agent',
  'src',
  'workflow',
  'AgentWorkflowRuntime.ts'
)

// 具体能力工具 schema 由各能力仓自持；这里只检查 Agent 自己的 workflow 工具。
const LockedToolBundles = []

function stableStringify(value) {
  return JSON.stringify(value, (_key, val) => {
    if (val && typeof val === 'object' && !Array.isArray(val)) return Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
    return val
  })
}

function bundleOf(collection) {
  const sources = Object.entries(collection).map(([name, tool]) => ({
    name,
    description: '',
    schema: tool.schema,
  }))
  return createToolSchemaBundle(sources)
}

// 消费一个 dist bundle 产物,缺失即失败(不静默跳过),返回 label→collection 映射供后续防线复用。
function loadLockedToolBundle({ package: packageName, bundlePath, buildHint }) {
  if (!existsSync(bundlePath)) {
    console.error(`❌ ${packageName}: 找不到 dist schema bundle(${bundlePath})——请先 build 该包:${buildHint}`)
    return null
  }
  const artifact = JSON.parse(readFileSync(bundlePath, 'utf8'))
  const collections = new Map(artifact.collections.map((collection) => [collection.label, collection]))
  return { packageName, collections }
}

// 对一个产物集合做零参数退化复核:声明了字段却 inputSchema 零 properties = 退化事故形态。
function assertNoZeroParamDegradation(label, tools) {
  let ok = true
  for (const tool of tools) {
    const propCount = Object.keys(tool.inputSchema?.properties ?? {}).length
    if ((tool.declaredParameterCount ?? 0) > 0 && propCount === 0) {
      console.error(`❌ ${label}/${tool.name}: 声明 ${tool.declaredParameterCount} 个字段但 JSON schema 零参数——退化事故形态`)
      ok = false
    }
  }
  return ok
}

let failed = false

// ── 防线①:被锁工具包 dist 产物存在 + 无零参数退化
const loadedBundles = new Map()
for (const spec of LockedToolBundles) {
  const loaded = loadLockedToolBundle(spec)
  if (!loaded) {
    failed = true
    continue
  }
  loadedBundles.set(spec.package, loaded)
  for (const [label, collection] of loaded.collections) {
    if (!assertNoZeroParamDegradation(label, collection.tools)) failed = true
    console.info(`✓ ${label}: ${collection.tools.length} 工具 dist 产物完整`)
  }
}

// agent-workflow 工具住在 desktop 壳(apps/desktop/src/main),无独立 dist 产物,就地构建其 inputSchema 面复核零参数退化。
try {
  const workflowBundle = bundleOf({ 'agent:run_workflow': { schema: agentWorkflowSchema } })
  const workflowTools = workflowBundle.tools.map((tool) => ({
    name: tool.name,
    inputSchema: tool.inputSchema,
    declaredParameterCount: Object.keys(agentWorkflowSchema?.shape ?? {}).length,
  }))
  if (!assertNoZeroParamDegradation('agent-workflow', workflowTools)) failed = true
  console.info(`✓ agent-workflow: ${workflowBundle.tools.length} 工具 bundle 完整`)
} catch (error) {
  console.error(`❌ agent-workflow: schema bundle 构建抛错(疑 transform 未走 io:'input'):${error.message}`)
  failed = true
}

// ── 防线②:Workflow IR 解释器不得获得通用代码执行或宿主权限
const workflowRuntimeSource = readFileSync(WorkflowRuntimePath, 'utf8')
const forbiddenWorkflowRuntimePatterns = [
  /from\s+['"]node:(?:fs|net|process|child_process|module|vm)['"]/,
  /from\s+['"]electron['"]/,
  /\brequire\s*\(/,
  /\bimport\s*\(/,
]
for (const pattern of forbiddenWorkflowRuntimePatterns) {
  if (!pattern.test(workflowRuntimeSource)) continue
  console.error(`❌ agent-workflow:解释器命中禁用能力模式 ${pattern}`)
  failed = true
}
console.info('✓ agent-workflow:解释器无 fs/network/process/require/import/Electron 能力；委派限制由 capability delegation policy 注入')

// 纯 IR contract smoke 属于构建期 check，不创建 tests/：固定输入必须稳定得到相同控制流结果。
const reviewSchema = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['verdict', 'confidence'],
  additionalProperties: false,
}
const fakeRuntime = new AgentWorkflowRuntime({
  dispatch: async ({ call, input, round }) => {
    let structured_output
    if (call.id.startsWith('review')) {
      structured_output = {
        verdict: call.id === 'review-c' ? 'reject' : 'approve',
        confidence: call.id === 'review-b' ? 0.9 : 0.8,
      }
    } else if (call.id.startsWith('stage')) {
      structured_output = { value: (input?.value ?? 0) + 1 }
    } else {
      structured_output = { items: [{ id: 'stable' }], round }
    }
    return { call_id: call.id, status: 'completed', summary: 'ok', structured_output }
  },
})

const voteRun = await fakeRuntime.run(agentWorkflowSchema.parse({
  name: 'check vote reducers',
  max_agents: 3,
  steps: [
    {
      id: 'reviews',
      operation: 'parallel',
      calls: ['review-a', 'review-b', 'review-c'].map((id) => ({ id, prompt: 'independent contract reviewer prompt', output_schema: reviewSchema })),
    },
    {
      id: 'confident',
      operation: 'filter',
      source: { step_id: 'reviews' },
      predicate: { path: ['structured_output', 'confidence'], op: 'gte', value: 0.8 },
    },
    {
      id: 'deduped',
      operation: 'dedupe',
      source: { step_id: 'confident' },
      key_paths: [['structured_output', 'verdict']],
      keep: 'highest_confidence',
      confidence_path: ['structured_output', 'confidence'],
    },
    {
      id: 'decision',
      operation: 'majority_vote',
      source: { step_id: 'reviews' },
      vote_path: ['structured_output', 'verdict'],
      quorum: 3,
    },
  ],
}), { runId: 'check:vote' })

const pipelineRun = await fakeRuntime.run(agentWorkflowSchema.parse({
  name: 'check pipeline',
  max_agents: 4,
  steps: [{
    id: 'pipeline',
    operation: 'pipeline',
    items: [{ value: 0 }, { value: 10 }],
    stages: ['stage-a', 'stage-b'].map((id) => ({ id, prompt: 'bounded pipeline contract stage', output_schema: reviewSchema })),
  }],
}), { runId: 'check:pipeline' })

const repeatRun = await fakeRuntime.run(agentWorkflowSchema.parse({
  name: 'check repeat',
  max_agents: 3,
  steps: [{
    id: 'repeat',
    operation: 'repeat',
    seed: { items: [] },
    call: { id: 'repeat-agent', prompt: 'bounded repeat contract worker', output_schema: reviewSchema },
    max_rounds: 3,
    convergence: { kind: 'no_new_items', items_path: ['items'], key_path: ['id'], patience: 1 },
  }],
}), { runId: 'check:repeat' })

const degradedRuntime = new AgentWorkflowRuntime({
  dispatch: async ({ call }) => {
    if (call.id === 'review-c') return { call_id: call.id, status: 'failed', summary: 'simulated provider failure' }
    return {
      call_id: call.id,
      status: 'completed',
      summary: 'ok',
      structured_output: { verdict: 'approve', confidence: 0.9 },
    }
  },
})
const degradedVoteRun = await degradedRuntime.run(agentWorkflowSchema.parse({
  name: 'check collected provider failure',
  max_agents: 3,
  steps: [
    {
      id: 'reviews',
      operation: 'parallel',
      failure_policy: 'collect',
      calls: ['review-a', 'review-b', 'review-c'].map((id) => ({ id, prompt: 'independent contract reviewer prompt', output_schema: reviewSchema })),
    },
    {
      id: 'decision',
      operation: 'majority_vote',
      source: { step_id: 'reviews' },
      vote_path: ['structured_output', 'verdict'],
      quorum: 2,
    },
  ],
}), { runId: 'check:degraded-vote' })

const voteWinner = voteRun.output?.groups?.[0]?.winner
const pipelineValues = pipelineRun.output?.map((lane) => lane.output?.value)
const repeatConverged = repeatRun.output?.converged
const degradedDecision = degradedVoteRun.output?.groups?.[0]
const degradedParallel = degradedVoteRun.steps[0]
const degradedVoteStable =
  degradedVoteRun.status === 'partial' &&
  degradedVoteRun.agent_count === 3 &&
  degradedParallel?.status === 'partial' &&
  degradedDecision?.status === 'decided' &&
  degradedDecision.winner === 'approve' &&
  degradedDecision.total_votes === 2 &&
  degradedDecision.quorum === 2
if (voteWinner !== 'approve' || stableStringify(pipelineValues) !== '[2,12]' || repeatConverged !== true || !degradedVoteStable) {
  console.error('❌ agent-workflow:纯 IR contract smoke 失败', { voteWinner, pipelineValues, repeatConverged, degradedVoteStable })
  failed = true
} else {
  console.info('✓ agent-workflow:parallel/filter/dedupe/majority_vote/pipeline/repeat 与 collect 降级票决纯 IR contract 稳定')
}

process.exit(failed ? 1 : 0)
