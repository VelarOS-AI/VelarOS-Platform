import assert from 'node:assert/strict'
import { test } from 'node:test'

import { AgentsLimits, InteractionLimits } from '../../../dist/act/agents/contract/constants.js'
import {
  VelarAgentsModule,
  VelarInteractionModule,
} from '../../../dist/act/agents/contract/surface.js'
import {
  agentsModule,
  interactionModule,
  interactionQuestions,
} from '../../../dist/act/agents/index.js'
import {
  interactionDetail,
  normalizeConfirmationAnswer,
  normalizeInteractionAnswer,
} from '../../../dist/act/agents/utils/answers.js'
import { checkInteractionRequest } from '../../../dist/act/agents/utils/requests.js'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'

test('INV-1 agents 的实际操作与模板一致', () =>
  verifyModule(agentsModule, new URL('../template.js', import.meta.url)))
test('INV-1 interaction 的实际操作与模板一致', () =>
  verifyModule(interactionModule, new URL('../interaction-template.js', import.meta.url)))

test('INV-2 声明里写给模型的上限与常量表一致', () => {
  for (const [surface, fragments] of [
    [
      VelarAgentsModule,
      [
        `materials 把已有原文引用复制给它（最多 ${AgentsLimits.materials} 条）`,
        `materials 最多 ${AgentsLimits.materials} 条`,
      ],
    ],
    [
      VelarInteractionModule,
      [
        `要对方回答的话：message 1 到 ${InteractionLimits.messageChars} 个字符`,
        `说明缺少的能力：message 1 到 ${InteractionLimits.messageChars} 个字符`,
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
