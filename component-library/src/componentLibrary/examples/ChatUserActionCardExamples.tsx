import {
  AskUserCarousel,
  UserActionCard as UserActionCardComponent,
} from '@catalog/adapters/UserActionPreview'
import type { ComponentProps, ReactElement } from 'react'

import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

const SESSION_ID = 'component-library-useraction'
const CREATED_AT = new Date('2026-07-20T10:00:00+08:00').getTime()
type UserActionCardBlock = ComponentProps<typeof UserActionCardComponent>['block']
type UserActionCard = UserActionCardBlock['card']

function toBlock(card: Omit<UserActionCard, 'createdAt'>): UserActionCardBlock {
  return { type: 'user-action-card', card: { ...card, createdAt: CREATED_AT } }
}

const approvalCard = toBlock({
  id: 'ua-approval',
  title: '方案待批准',
  description: 'AI 拟定了「登录页重构」方案,批准后开始执行。',
  tone: 'info',
  icon: 'plan',
  blocking: true,
  actions: [
    { kind: 'acknowledge', label: '批准执行', icon: 'confirm' },
    { kind: 'reject', label: '退回修改', icon: 'reject', input: { placeholder: '说明退回原因(可选)' } },
  ],
})

const acknowledgeCard = toBlock({
  id: 'ua-ack',
  title: '已切换到浏览器空间',
  description: '当前会话进入浏览器自动化模式,工具集已切换。',
  tone: 'success',
  icon: 'workspace',
  blocking: false,
  actions: [{ kind: 'acknowledge', label: '知道了', icon: 'confirm' }],
})

const enableFeaturesCard = toBlock({
  id: 'ua-enable',
  title: '启用方案模式?',
  description: '开启后 AI 会先给方案、经你批准再执行破坏性操作。',
  tone: 'warning',
  icon: 'plugin',
  blocking: true,
  actions: [
    {
      kind: 'enable_prompt_features',
      label: '开启方案模式',
      icon: 'plan',
      promptFeatures: ['proposal'],
      completedLabel: '已开启',
    },
  ],
})

const choiceFormCard = toBlock({
  id: 'ua-choice',
  title: '选择部署目标',
  description: '挑一个环境继续。',
  tone: 'info',
  icon: 'target',
  blocking: true,
  actions: [{ kind: 'submit_form', label: '确定' }],
  form: {
    layout: 'stack',
    fields: [
      {
        id: 'env',
        type: 'radio',
        label: '环境',
        required: true,
        options: [
          { value: 'staging', label: '预发', description: '内测环境' },
          { value: 'prod', label: '生产', recommended: true },
        ],
      },
      { id: 'notes', type: 'textarea', label: '备注', placeholder: '可选' },
    ],
  },
})

const textInputCard = toBlock({
  id: 'ua-input',
  title: '给这次运行起个名字',
  description: '便于稍后在归档里检索。',
  tone: 'info',
  icon: 'info',
  blocking: true,
  actions: [
    {
      kind: 'submit_input',
      label: '保存',
      icon: 'send',
      input: { placeholder: '例如:登录页重构', required: true, maxLength: 60 },
    },
  ],
})

const wizardCard = toBlock({
  id: 'ua-wizard',
  title: '2 个问题需要你拍板',
  description: '在选项间选择,或在下面自由输入你的答案。',
  tone: 'info',
  icon: 'info',
  blocking: true,
  actions: [{ kind: 'submit_form', label: '提交' }],
  form: {
    layout: 'stack',
    presentation: 'wizard',
    fields: [
      {
        id: 'q0',
        type: 'radio',
        label: '这个项目最终要产出什么?',
        options: [
          { value: 'web', label: 'Web 前端应用', description: '浏览器端交互应用' },
          { value: 'fullstack', label: '全栈 Web 应用', description: '带 API 服务的全栈应用' },
          { value: 'cli', label: 'CLI / 后端服务', description: '命令行工具或后端服务,无 UI' },
        ],
      },
      {
        id: 'q1',
        type: 'radio',
        label: '技术栈有偏好吗?',
        options: [
          { value: 'ts', label: 'TypeScript 全栈', description: 'React + Node.js' },
          { value: 'py', label: 'Python 生态', description: 'FastAPI / Django' },
          { value: 'auto', label: '由你推荐', description: '根据项目类型推荐', recommended: true },
        ],
      },
    ],
  },
})

/** UserActionCard:批准 / 确认 / 启用能力 三种 action 形态。 */
export function UserActionCardActionExample(): ReactElement {
  return (
    <Stack gap="sm">
      <UserActionCardComponent block={approvalCard} sessionId={SESSION_ID} onActionComplete={() => undefined} />
      <UserActionCardComponent block={acknowledgeCard} sessionId={SESSION_ID} onActionComplete={() => undefined} />
      <UserActionCardComponent block={enableFeaturesCard} sessionId={SESSION_ID} onActionComplete={() => undefined} />
    </Stack>
  )
}

/** UserActionCard.form:选择表单(radio/textarea)与文本输入两种表单形态。 */
export function UserActionCardFormExample(): ReactElement {
  return (
    <Stack gap="sm">
      <UserActionCardComponent block={choiceFormCard} sessionId={SESSION_ID} onActionComplete={() => undefined} />
      <UserActionCardComponent block={textInputCard} sessionId={SESSION_ID} onActionComplete={() => undefined} />
    </Stack>
  )
}

/** blocking 卡的失活态:disabled=true(非当前活跃卡,按钮禁用)。 */
export function UserActionCardDisabledExample(): ReactElement {
  return (
    <UserActionCardComponent
      block={approvalCard}
      sessionId={`${SESSION_ID}-disabled`}
      disabled
      onActionComplete={() => undefined}
    />
  )
}

/** AskUserCarousel:wizard 形态,把 form.fields 按问题分页逐题作答(收割自真实 ask_user)。 */
export function AskUserCarouselExample(): ReactElement {
  return <AskUserCarousel block={wizardCard} sessionId={SESSION_ID} onActionComplete={() => undefined} />
}
