import assert from 'node:assert/strict'
import { describe, test } from 'node:test'

import type { ToolCallBlock } from '../../packages/ui/src/conversation/contracts'
import { getMergedToolDetails } from '../../packages/ui/src/conversation/tool-render/messageBubbleToolModel'
import {
  getToolActivitySummary,
  getToolDetailItems,
  getToolDetailSummary,
} from '../../packages/ui/src/conversation/tool-render/toolCallSummary'
import { getToolOperations } from '../../packages/ui/src/conversation/tool-render/toolOperationSummary'
import { getToolTargetSummary } from '../../packages/ui/src/conversation/tool-render/toolTargetSummary'

function call(
  toolName: string,
  args: Record<string, unknown>,
  result?: unknown,
  id = toolName
): ToolCallBlock {
  return { type: 'tool-call', toolCallId: id, toolName, args, result }
}

function target(toolName: string, args: Record<string, unknown>, result?: unknown): Nullable<string> {
  return getToolDetailSummary(call(toolName, args, result))
}

const threeStepPlan = [
  { step: '定位保存失败', status: 'completed' },
  { step: '实现修复', status: 'in_progress' },
  { step: '跑验证', status: 'pending' },
]

void describe('plan and goal rows say which step and what changed', () => {
  void test('plan:update names the progress and the step in progress, and lists every step in the details', () => {
    const block = call('plan:update', { plan: threeStepPlan })

    assert.equal(getToolDetailSummary(block), '1/3 · 实现修复')
    assert.deepEqual(getToolDetailItems(block), [
      '1. [completed] 定位保存失败',
      '2. [in_progress] 实现修复',
      '3. [pending] 跑验证',
    ])
  })

  void test('plan:update names the step it completed, resolved from the result or from the plan', () => {
    const result = {
      updated: true,
      plan: [
        { title: '定位保存失败', status: 'completed' },
        { title: '实现修复', status: 'completed' },
        { title: '跑验证', status: 'running' },
      ],
      completedSteps: [{ step: '实现修复', status: 'completed' }],
    }
    assert.equal(target('plan:update', { complete_step: 2 }, result), '2/3 · 实现修复 → completed')
    // 还没有结果：按参数里的计划解析序号；连计划都没有时原样写序号。
    assert.equal(target('plan:update', { plan: threeStepPlan, complete_step: 1 }), '1/3 · 定位保存失败 → completed')
    assert.equal(target('plan:update', { complete_step: 2 }), '#2 → completed')
  })

  void test('plan:update shows an explicit lifecycle change and falls back to the explanation', () => {
    const result = { plan: [{ title: '实现修复', status: 'running' }] }
    assert.equal(target('plan:update', { lifecycle: 'paused' }, result), 'paused · 0/1 · 实现修复')
    assert.equal(target('plan:update', { explanation: '改为先写测试' }), '改为先写测试')
    assert.equal(target('plan:update', {}, { updated: false, noop: true, plan: [] }), null)
  })

  void test('plan step details hide objectives that only name a system workspace, matched on ASCII word boundaries', () => {
    const plan = (objective: string): Record<string, unknown> => ({
      plan: [{ id: 'step-1', title: 'Write output', objective, status: 'running' }],
    })

    assert.deepEqual(getToolDetailItems(call('plan:update', plan('write to system workspace'))), [
      '1. [running] Write output',
    ])
    assert.deepEqual(getToolDetailItems(call('plan:update', plan('write to nonsystem workspacey'))), [
      '1. [running] Write output · write to nonsystem workspacey',
    ])
  })

  void test('plan:get reports the plan it read; an active lifecycle is not repeated', () => {
    const result = { lifecycle: 'active', plan: [{ title: '定位', status: 'completed' }, { title: '修复', status: 'running' }] }
    assert.equal(target('plan:get', {}, result), '1/2 · 修复')
    assert.equal(target('plan:get', {}, { ...result, lifecycle: 'paused' }), 'paused · 1/2 · 修复')
  })

  void test('goal rows name the goal, its status change or the step it completed', () => {
    const goal = {
      objective: '修复保存失败并跑验证',
      status: 'active',
      steps: [
        { step: '定位保存失败路径', status: 'completed' },
        { step: '跑验证', status: 'in_progress' },
      ],
    }

    assert.equal(target('goal:create', { objective: '修复保存失败并跑验证' }), '修复保存失败并跑验证')
    assert.equal(target('goal:update', { status: 'complete' }, { status: 'complete', goal }), 'complete · 修复保存失败并跑验证')
    assert.equal(
      target('goal:update', { complete_step: 1 }, { goal, completedStep: { step: '定位保存失败路径' } }),
      '定位保存失败路径 → completed'
    )
    assert.equal(target('goal:update', { steps: [{ step: '跑验证', status: 'in_progress' }] }), '0/1 · 跑验证')
    assert.equal(target('goal:get', {}, { status: 'active', goal }), 'active · 修复保存失败并跑验证')
    // 悬停详情给出目标全文与每一步。
    assert.deepEqual(getToolDetailItems(call('goal:get', {}, { status: 'active', goal })), [
      '修复保存失败并跑验证',
      '1. [completed] 定位保存失败路径',
      '2. [in_progress] 跑验证',
    ])
  })

  void test('the goal:update complete_step operation names the step instead of its number', () => {
    assert.deepEqual(
      getToolOperations(call('goal:update', { complete_step: 1 }, { completedStep: { step: '定位保存失败路径' } })),
      [{ id: 'complete_step', target: '定位保存失败路径' }]
    )
    assert.deepEqual(
      getToolOperations(call('goal:update', { status: 'complete' }, { goal: { objective: '修复保存失败' } })),
      [{ id: 'complete', target: '修复保存失败' }]
    )
  })

  void test('merged plan rows preview each call the same way a single row does', () => {
    assert.deepEqual(
      getMergedToolDetails([
        call('plan:update', { plan: threeStepPlan }, undefined, 'plan-a'),
        call('plan:update', { complete_step: 2 }, { completedSteps: [{ step: '实现修复' }] }, 'plan-b'),
      ]),
      ['1/3 · 实现修复', '实现修复 → completed']
    )
  })
})

void describe('agent, context and interaction rows', () => {
  void test('name the sub-agent, the recalled reference, the handoff reason and the background job', () => {
    assert.equal(
      target('agent:dispatch', { agent_name: 'Scout', description: 'Scan auth module', prompt: 'Read src/auth.' }),
      'Scout · Scan auth module'
    )
    assert.equal(target('agent:dispatch', { thread_id: 'subagent:verifier', prompt: 'Re-verify.' }), 'subagent:verifier')
    assert.equal(target('agent:run_workflow', { name: 'Independent review vote', steps: [] }), 'Independent review vote')
    assert.equal(target('context:recall', { ref: 'call_abc', jsonPath: '$.entries', refKind: 'tool-payload' }), 'call_abc · $.entries')
    assert.equal(target('context:handoff', { reason: '新会话从验证失败继续修复' }), '新会话从验证失败继续修复')
    assert.equal(target('job:wait', { job_ids: ['job-1', 'job-2'] }), 'job-1 +1')
    assert.equal(target('job:read_output', { job_id: 'job-1', filter: 'error' }), 'job-1')
    assert.deepEqual(getToolDetailItems(call('job:read_output', { job_id: 'job-1', filter: 'error' })), ['filter: error'])
    assert.deepEqual(getToolOperations(call('context:recall', { ref: 'call_abc', refKind: 'tool-payload' })), [
      { id: 'tool-payload', target: 'call_abc' },
    ])
  })

  void test('name the question, the answer, the action card and the directive', () => {
    const questions = [{ question: '用哪种缓存策略？', header: '缓存策略', options: [{ label: '内存 LRU' }, { label: 'Redis' }] }]
    const answered = call('interaction:ask_user', { questions }, { answers: [{ selected: ['内存 LRU'] }] })

    assert.equal(getToolDetailSummary(answered), '缓存策略')
    assert.deepEqual(getToolDetailItems(answered), ['用哪种缓存策略？ → 内存 LRU'])
    assert.equal(target('interaction:show_action_cards', { cards: [{ title: '确认', description: '继续吗？' }] }), '确认')
    assert.equal(target('interaction:confirm', { message: '即将运行会写文件的命令' }), '即将运行会写文件的命令')
    assert.equal(target('interaction:read_me', { modules: ['basics', 'form'] }), 'basics · form')
    assert.deepEqual(getToolOperations(call('directive:upsert', { title: '禁止自动重建索引', content: '…', directiveType: 'prohibition' })), [
      { id: 'prohibition', target: '禁止自动重建索引' },
    ])
    assert.deepEqual(
      getToolDetailItems(call('directive:list', {}, { directives: [{ title: '回复用中文' }], count: 1 })),
      ['回复用中文']
    )
  })
})

void describe('browser rows', () => {
  void test('inspection tools name the page from their result', () => {
    const page = { url: 'http://localhost:3000/login', title: '登录 - Demo' }

    assert.equal(target('browser:get_page_state', {}, page), '登录 - Demo')
    assert.deepEqual(getToolDetailItems(call('browser:inspect_page', {}, page)), ['http://localhost:3000/login'])
    assert.equal(target('browser:site_context', {}, { browserContext: { url: 'http://localhost:3000' } }), 'http://localhost:3000')
    assert.equal(
      target('browser:list_page_targets', {}, { targets: [{ title: '首页', active: true }, { title: '文档', active: false }] }),
      '首页'
    )
    assert.equal(target('browser:capture_screenshot', { fullPage: true }, { url: page.url, relativePath: 'shots/1.png' }), page.url)
  })

  void test('browser:act reads like its operation, and the composite tools name their action and subject', () => {
    assert.equal(target('browser:act', { action: 'target', targetAction: 'click', targetRef: '@e3:g1' }), 'target.click · @e3:g1')
    assert.equal(target('browser:act', { action: 'press_key', key: 'Enter' }), 'press_key · Enter')
    assert.equal(target('browser:files', { action: 'read_file', path: 'recipes/login.json' }), 'read_file · recipes/login.json')
    assert.equal(target('browser:extract', { action: 'content', format: 'markdown' }), 'content · markdown')
    assert.equal(target('browser:user_scripts', { action: 'create', name: 'Hide popup', code: 'x' }), 'create · Hide popup')
    assert.equal(target('browser:read_page_data', { preset: 'selector_text', selector: '.title' }), 'selector_text · .title')
  })

  void test('event, network and diagnostics tools name what they handled or filtered', () => {
    assert.equal(target('browser:handle_dialog', { accept: false, promptText: 'VelarOS' }), 'accept: false · VelarOS')
    assert.equal(target('browser:handle_permission', { grant: true }), 'grant: true')
    assert.equal(target('browser:handle_download', { action: 'accept', savePath: 'downloads/a.pdf' }), 'accept · downloads/a.pdf')
    assert.equal(target('browser:list_console_events', { errorsOnly: true, level: 'error' }), 'error · errorsOnly')
    assert.equal(target('browser:list_network_events', { status: 404 }), '404')
    assert.equal(target('browser:query_elements', { selector: '[data-testid=price]' }), '[data-testid=price]')
    assert.equal(
      target('browser:get_network_request', { requestId: '1.2' }, { request: { method: 'GET', url: 'http://x/api' } }),
      'GET · http://x/api'
    )
    assert.equal(target('browser:get_network_request', { requestId: '1.2' }), '1.2')
  })
})

void describe('workbench, desktop and capability rows', () => {
  void test('workbench tools name the files, lines, runs and problem counts', () => {
    assert.equal(
      target('workbench:open_file', {
        files: [
          { path: 'src/router.ts', highlights: [{ startLine: 42, endLine: 58 }] },
          { path: 'src/auth.ts', line: 10 },
        ],
      }),
      'src/router.ts:42-58 +1'
    )
    assert.equal(
      target('workbench:explain_code', { explanations: [{ path: 'src/cache.ts', startLine: 12, endLine: 30, text: '…' }] }),
      'src/cache.ts:12-30'
    )
    assert.equal(target('workbench:get_editor_state', {}, { view: 'file', activeFile: { path: 'src/cache.ts', line: 12 } }), 'src/cache.ts:12')
    assert.equal(target('workbench:read_run', { waitFor: 'compiled' }), 'compiled')
    assert.equal(target('workbench:get_problems', { paths: ['src/cache.ts'] }, { errors: 2, warnings: 1 }), 'src/cache.ts · ⊗ 2 ⚠ 1')
  })

  void test('desktop, system, computer, office and memory tools name their subject', () => {
    assert.equal(target('schedule:propose', { name: '每日仓库巡检', prompt: '…', scheduleText: '工作日 9 点' }), '每日仓库巡检')
    assert.deepEqual(getToolOperations(call('schedule:update', { taskId: 't-1', enabled: false, rrule: 'FREQ=DAILY' })), [
      { id: 'enabled', target: 'false' },
      { id: 'rrule', target: 'FREQ=DAILY' },
    ])
    assert.equal(target('peer:send', { to_session_id: 'member-2f9c', message: '我先改 channels.ts' }), 'member-2f9c · 我先改 channels.ts')
    assert.equal(target('proposal:get', {}, { status: 'reviewing', proposal: { title: '统一认证' } }), 'reviewing · 统一认证')
    assert.equal(target('task:flag', { title: '修复变量缺失', tldr: '按钮无色', prompt: '…' }), '修复变量缺失')
    assert.equal(target('system:processes', { include: ['ports'], port: 3000 }), ':3000')
    assert.equal(target('system:search', { path: '~', pattern: 'ERROR' }), 'ERROR')
    assert.equal(target('system:terminate-task', { taskId: 'task-abc' }), 'task-abc')
    assert.equal(target('computer:click', { x: 756, y: 342 }), '756, 342')
    assert.equal(target('computer:key', { keys: 'cmd+a' }), 'cmd+a')
    assert.equal(target('computer:screen_size', {}, { width: 1440, height: 900 }), '1440×900')
    assert.equal(target('office:convert_pdf_to_word', { inputPath: 'paper.pdf', outputPath: 'paper.docx' }), 'paper.pdf → paper.docx')
    assert.equal(target('office:create_word_document', { outputPath: 'report.docx', title: '季度报告', content: '#' }), 'report.docx')
    assert.equal(target('memory:get', { id: 'project:/repo::entries/a.md' }, { memory: { title: '回复风格' } }), '回复风格')
    assert.equal(target('project:query-code', { action: 'index_status' }), 'index_status')
  })

  void test('rows from external engines read their argument spellings', () => {
    assert.equal(target('project:read', { file_path: 'src/index.ts' }), 'src/index.ts')
    assert.equal(target('project:search', { pattern: 'TODO', path: 'src' }), 'TODO')
    assert.equal(target('project:list', { pattern: '**/*.test.ts' }), '**/*.test.ts')
    assert.equal(target('project:list', { path: '.', maxDepth: 2 }), '.')
  })

  void test('uses the host path formatter and resolves paths against the call cwd', () => {
    const formatPath = (path: string): string => path.replace('/repo/', '')

    assert.equal(
      getToolDetailSummary(call('office:preview_document', { inputPath: 'report.docx', cwd: '/repo' }), formatPath),
      'report.docx'
    )
    assert.equal(
      getToolDetailSummary(call('workbench:open_file', { path: '/repo/src/main.ts', line: 3 }), formatPath),
      'src/main.ts:3'
    )
  })
})

void describe('summaries stay short and never invent data', () => {
  void test('long texts are folded to one line and cut, and payloads never reach the row', () => {
    const prompt = `为咖啡店做海报\n${'暖色调，手写字体，'.repeat(40)}`
    const summary = target('media:generate_image', { prompt })

    assert.ok(summary)
    assert.ok(summary.length <= 121, `too long: ${summary.length}`)
    assert.doesNotMatch(summary, /\n/)
    assert.ok(summary.endsWith('…'))
    // 悬停详情给得更全，但同样有上限。
    const [detail] = getToolDetailItems(call('media:generate_image', { prompt }))
    assert.ok(detail && detail.length > summary.length && detail.length <= 401)
    assert.equal(target('ui:show_widget', { title: 'sales_chart', widget_code: '<svg>…</svg>' }), 'sales_chart')
  })

  void test('reads nothing that is not in the arguments or the result', () => {
    assert.equal(getToolTargetSummary(call('browser:leave_site', {})), null)
    assert.equal(getToolTargetSummary(call('peer:list', {})), null)
    assert.equal(getToolTargetSummary(call('knowledge:diagnostics', {})), null)
    assert.equal(getToolTargetSummary(call('computer:screenshot', {})), null)
    assert.equal(getToolTargetSummary(call('some:unknown_tool', { anything: 1 })), null)
    assert.equal(target('browser:wait_for_pending_event', {}), null)
  })

  void test('the running label of a host status line picks up the same target', () => {
    assert.equal(
      getToolActivitySummary({ ...call('plan:update', { plan: threeStepPlan }), isRunning: true }, 'zh-CN', undefined, {
        translate: (_locale, key, params) => `${key}:${String(params?.action)}`,
        lookupMessage: () => null,
      }),
      'toolSummary.runningAction:plan:update · 1/3 · 实现修复'
    )
  })
})
