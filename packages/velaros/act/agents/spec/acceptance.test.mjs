import assert from 'node:assert/strict'
import { test } from 'node:test'

import { localContextStorage } from '@velaros-ai/context/node'
import { nodeSubprocessCodeRunner } from '@velaros-ai/script'

import {
  AgentsLimits,
  InteractionLimits,
  WidgetLimits,
} from '../../../dist/act/agents/contract/constants.js'
import {
  VelarAgentsModule,
  VelarInteractionModule,
  VelarWidgetModule,
} from '../../../dist/act/agents/contract/surface.js'
import { widgetOperations } from '../../../dist/act/agents/impl/WidgetOperations.js'
import {
  agentsModule,
  interactionModule,
  interactionQuestions,
  widgetModule,
} from '../../../dist/act/agents/index.js'
import {
  interactionDetail,
  normalizeConfirmationAnswer,
  normalizeInteractionAnswer,
} from '../../../dist/act/agents/utils/answers.js'
import { checkInteractionRequest } from '../../../dist/act/agents/utils/requests.js'
import { createRuntime } from '../../../dist/act/runtime/index.js'
import { done, turn } from '../../runtime/test/support/model-turn.mjs'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'

test('INV-1 agents 的实际操作与模板一致', () =>
  verifyModule(agentsModule, new URL('../template.js', import.meta.url)))
test('INV-1 interaction 的实际操作与模板一致', () =>
  verifyModule(interactionModule, new URL('../interaction-template.js', import.meta.url)))
test('INV-1 widget 的实际操作与模板一致', () =>
  verifyModule(widgetModule, new URL('../widget-template.js', import.meta.url)))

test('INV-2 声明里写给模型的上限与常量表一致', () => {
  for (const [surface, fragments] of [
    [
      VelarAgentsModule,
      [
        `materials 把已有原文引用复制给它（最多 ${AgentsLimits.materials} 条）`,
        `materials 最多 ${AgentsLimits.materials} 条`,
        `ids 最多 ${AgentsLimits.waitTargets} 个且不能重复`,
        `ids 需要 1 到 ${AgentsLimits.waitTargets} 个互不重复的 job.id`,
      ],
    ],
    [
      VelarInteractionModule,
      [
        `要对方回答的话：message 1 到 ${InteractionLimits.messageChars} 个字符`,
        `要对方确认的话：message 1 到 ${InteractionLimits.messageChars} 个字符`,
      ],
    ],
    [
      VelarWidgetModule,
      [
        `给用户看的标题，1 到 ${WidgetLimits.titleChars} 个字符`,
        `1 到 ${WidgetLimits.codeChars} 个字符`,
        `${WidgetLimits.minHeight} 到 ${WidgetLimits.maxHeight}，缺省 ${WidgetLimits.defaultHeight}`,
      ],
    ],
  ])
    for (const fragment of fragments)
      assert.ok(
        surface.declarations.includes(fragment),
        `${surface.specifier} 的声明里没有「${fragment}」`
      )
})

const choices = {
  message: '改动先应用到哪个环境？',
  options: [
    { id: 'staging', label: '预发环境', recommended: true },
    { id: 'production', label: '生产环境' },
  ],
  allowText: true,
}
const form = {
  message: '请填写发布信息。',
  fields: [
    { id: 'version', label: '版本号', kind: 'text', required: true },
    { id: 'replicas', label: '副本数', kind: 'number' },
    { id: 'notify', label: '通知团队', kind: 'boolean' },
    {
      id: 'regions',
      label: '区域',
      kind: 'choice',
      multiple: true,
      options: [
        { id: 'cn', label: '中国' },
        { id: 'us', label: '美国' },
      ],
    },
  ],
}

test('INV-3 选择题与表单的形状在发起前核对', () => {
  checkInteractionRequest(choices)
  checkInteractionRequest(form)
  for (const bad of [
    { message: 'x', options: [{ id: 'a', label: 'A' }] },
    {
      message: 'x',
      options: [
        { id: 'a', label: 'A' },
        { id: 'a', label: 'B' },
      ],
    },
    {
      message: 'x',
      options: [
        { id: 'a', label: 'A', recommended: true },
        { id: 'b', label: 'B', recommended: true },
      ],
    },
    { message: 'x', multiple: true },
    { ...choices, fields: form.fields },
    { message: 'x', fields: [] },
    { message: 'x', fields: [{ id: 'f', label: 'F', kind: 'choice' }] },
    { message: 'x', fields: [{ id: 'f', label: 'F', kind: 'text', options: choices.options }] },
  ])
    assert.throws(() => checkInteractionRequest(bad), { code: 'VALIDATION' }, JSON.stringify(bad))
})

test('INV-4 提问详情只带选项与表单；回答只留下和问题对得上的部分', () => {
  assert.equal(interactionDetail({ message: '一句话的问题' }), undefined)
  assert.deepEqual(interactionDetail(choices), { options: choices.options, allowText: true })
  assert.deepEqual(normalizeInteractionAnswer(choices, 'staging 就行'), { text: 'staging 就行' })
  assert.deepEqual(
    normalizeInteractionAnswer(choices, {
      choices: ['production', 'staging', 'nope'],
      text: '先试',
    }),
    { text: '先试', choices: ['production'] }
  )
  assert.deepEqual(
    normalizeInteractionAnswer(form, {
      values: { version: 'v2', replicas: '3', notify: 'yes', regions: ['us', 'mars'], extra: 1 },
    }),
    { values: { version: 'v2', replicas: 3, regions: ['us'] } }
  )
  assert.deepEqual(normalizeInteractionAnswer(form, { declined: true, message: '稍后再说' }), {
    declined: true,
    reason: '稍后再说',
  })
})

test('INV-4 确认的回答：布尔值与 approved 照实转，含糊的回答按不同意', () => {
  assert.deepEqual(normalizeConfirmationAnswer(true), { approved: true })
  assert.deepEqual(normalizeConfirmationAnswer({ approved: false, message: '命令太危险' }), {
    approved: false,
    reason: '命令太危险',
  })
  assert.deepEqual(normalizeConfirmationAnswer({ approved: true, reason: '忽略' }), {
    approved: true,
  })
  assert.deepEqual(normalizeConfirmationAnswer('好的'), { approved: false, reason: '好的' })
  assert.deepEqual(normalizeConfirmationAnswer(undefined), { approved: false })
})

test('INV-5 宿主读提问：带选项或表单的原样还原，普通问题与坏形状返回 null', () => {
  const detail = interactionDetail(choices)
  assert.deepEqual(
    interactionQuestions.read({ kind: 'input', message: choices.message, detail }),
    choices
  )
  assert.deepEqual(
    interactionQuestions.read({
      kind: 'input',
      message: form.message,
      detail: interactionDetail(form),
    }),
    form
  )
  assert.equal(interactionQuestions.read({ kind: 'input', message: '一句话' }), null)
  assert.equal(interactionQuestions.read({ kind: 'confirmation', message: 'x', detail }), null)
  assert.equal(
    interactionQuestions.read({ kind: 'input', message: 'x', detail: { options: [{ id: 1 }] } }),
    null
  )
  assert.equal(
    interactionQuestions.read({
      kind: 'input',
      message: 'x',
      detail: { options: [{ id: 'only', label: '只有一个' }] },
    }),
    null
  )
})

test('INV-6 小部件核对长度、收好高度后交给宿主；宿主不给显示端口就没有这个模块', async (t) => {
  const shown = []
  const ctx = {
    show: async (widget) => {
      shown.push(widget)
    },
    invocationId: 'call-1',
    abortSignal: new AbortController().signal,
  }
  await widgetOperations.show({ title: ' 访问量 ', code: '<svg></svg>', height: 20 }, ctx)
  await widgetOperations.show({ title: '大图', code: '<div></div>', height: 5000 }, ctx)
  await widgetOperations.show({ title: '缺省', code: '<div></div>' }, ctx)
  assert.deepEqual(
    shown.map((widget) => [widget.id, widget.title, widget.height]),
    [
      ['call-1', '访问量', WidgetLimits.minHeight],
      ['call-1', '大图', WidgetLimits.maxHeight],
      ['call-1', '缺省', WidgetLimits.defaultHeight],
    ]
  )
  for (const bad of [
    { title: ' ', code: '<div></div>' },
    { title: '空', code: ' ' },
    { title: 'x'.repeat(WidgetLimits.titleChars + 1), code: '<div></div>' },
    { title: '太长', code: 'x'.repeat(WidgetLimits.codeChars + 1) },
  ])
    await assert.rejects(widgetOperations.show(bad, ctx), { code: 'VALIDATION' })

  const received = []
  let calls = 0
  const model = (stream) => ({
    id: 'fixture',
    limits: { contextTokens: 100000, inputTokens: 90000, outputTokens: 4096 },
    estimate: async () => ({ tokens: 1000, precision: 'exact', basis: 'fixture' }),
    stream,
  })
  const runtime = await createRuntime({
    storage: localContextStorage({ path: ':memory:' }),
    runner: nodeSubprocessCodeRunner,
    modules: [],
    widgets: { show: (widget, sessionId) => received.push({ ...widget, sessionId }) },
    model: model(async function* (request) {
      if (++calls === 1) {
        yield turn(request, {
          execute: {
            source:
              "import {show} from 'velaros:widget';await show({title:'趋势',code:'<svg></svg>'});",
          },
        })
        yield { type: 'finish', reason: 'stop' }
      } else yield* done(request)
    }),
  })
  t.after(() => runtime.close())
  assert.ok(runtime.modules().items.some((item) => item.binding.moduleId === 'velaros:widget'))
  const session = await runtime.openSession('main')
  for await (const event of session.submit('画一张趋势图'))
    assert.equal(typeof event.type, 'string')
  assert.equal(received.length, 1)
  assert.equal(received[0].title, '趋势')
  assert.equal(received[0].height, WidgetLimits.defaultHeight)
  assert.equal(received[0].sessionId, 'main')
  assert.ok(received[0].id)

  const bare = await createRuntime({
    storage: localContextStorage({ path: ':memory:' }),
    runner: nodeSubprocessCodeRunner,
    modules: [],
  })
  t.after(() => bare.close())
  assert.ok(!bare.modules().items.some((item) => item.binding.moduleId === 'velaros:widget'))
})
