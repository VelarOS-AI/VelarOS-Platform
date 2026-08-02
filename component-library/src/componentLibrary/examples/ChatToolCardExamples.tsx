import { toOptional } from '@catalog/catalogPrimitives'
import type { ComponentProps, ReactElement } from 'react'

import { ToolCallBlock } from '@velaros-ai/ui/conversation/tool-render/ToolCallBlock'
import { Stack } from '@velaros-ai/ui/primitives/layout/Stack'

const SESSION_ID = 'component-library-session'
type ToolCallBlockType = ComponentProps<typeof ToolCallBlock>['block']

/** 统一渲染一枚工具卡:dispatch 由 block.toolName 路由到对应 renderer。 */
function ToolCard({
  block,
  compact = true,
}: {
  block: ToolCallBlockType
  compact?: boolean
}): ReactElement {
  return <ToolCallBlock block={block} compact={compact} sessionId={SESSION_ID} />
}

function commandBlock(overrides: Partial<ToolCallBlockType>): ToolCallBlockType {
  return {
    type: 'tool-call',
    toolCallId: `cmd-${overrides.toolCallId ?? 'x'}`,
    toolName: 'bash',
    args: { command: 'bun run build' },
    ...overrides,
  }
}

/** Command(bash / project:run) 工具卡:running / success / error / timedOut 四态。 */
export function CommandToolCardExample(): ReactElement {
  return (
    <Stack gap="sm">
      <ToolCard block={commandBlock({ toolCallId: 'run', isRunning: true })} />
      <ToolCard
        block={commandBlock({
          toolCallId: 'ok',
          result: {
            command: 'bun run build',
            cwd: '/workspace',
            exitCode: 0,
            stdout: 'Build complete in 4.2s\n12 modules transformed.',
            stderr: '',
            durationMs: 4200,
            timedOut: false,
            truncated: false,
            success: true,
          },
        })}
      />
      <ToolCard
        block={commandBlock({
          toolCallId: 'err',
          args: { command: 'bun run tpecheck' },
          result: {
            command: 'bun run tpecheck',
            cwd: '/workspace',
            exitCode: 127,
            stdout: '',
            stderr: 'error: Script not found "tpecheck"',
            durationMs: 90,
            timedOut: false,
            truncated: false,
            success: false,
          },
        })}
      />
      <ToolCard
        block={commandBlock({
          toolCallId: 'timeout',
          args: { command: 'bun run dev' },
          result: {
            command: 'bun run dev',
            cwd: '/workspace',
            exitCode: null,
            stdout: 'server starting…',
            stderr: '',
            durationMs: 120000,
            timedOut: true,
            truncated: false,
            success: false,
          },
        })}
      />
    </Stack>
  )
}

/** Default renderer(未注册工具名,如 project:read):running / success / error 三态。 */
export function DefaultToolCardExample(): ReactElement {
  return (
    <Stack gap="sm">
      <ToolCard
        block={{
          type: 'tool-call',
          toolCallId: 'read-run',
          toolName: 'project:read',
          args: { path: 'src/greeter.ts' },
          isRunning: true,
        }}
      />
      <ToolCard
        block={{
          type: 'tool-call',
          toolCallId: 'read-ok',
          toolName: 'project:read',
          args: { path: 'src/greeter.ts' },
          result: {
            path: 'src/greeter.ts',
            content: 'export function greet(name: string): string {\n  return `Hi, ${name}`\n}',
          },
        }}
      />
      <ToolCard
        block={{
          type: 'tool-call',
          toolCallId: 'read-err',
          toolName: 'project:read',
          args: { path: 'src/missing.ts' },
          error: 'ENOENT: no such file or directory, open "src/missing.ts"',
        }}
      />
    </Stack>
  )
}

/** Plan renderer(plan:update / proposal:review):in-progress / completed / failed 三态。 */
export function PlanToolCardExample(): ReactElement {
  const steps = (statuses: readonly string[]): Array<{ step: string; status: string }> =>
    ['盘点渲染管线', '收割真实 fixture', '补图鉴条目', '跑门禁'].map((step, index) => ({
      step,
      status: statuses[index] ?? 'pending',
    }))

  return (
    <Stack gap="sm">
      <ToolCard
        compact={false}
        block={{
          type: 'tool-call',
          toolCallId: 'plan-progress',
          toolName: 'plan:update',
          args: {
            explanation: '按顺序推进图鉴建设。',
            plan: steps(['completed', 'in_progress', 'pending', 'pending']),
          },
        }}
      />
      <ToolCard
        compact={false}
        block={{
          type: 'tool-call',
          toolCallId: 'plan-done',
          toolName: 'plan:update',
          args: {
            explanation: '全部完成。',
            plan: steps(['completed', 'completed', 'completed', 'completed']),
          },
        }}
      />
      <ToolCard
        compact={false}
        block={{
          type: 'tool-call',
          toolCallId: 'plan-failed',
          toolName: 'plan:update',
          args: {
            explanation: '门禁未过。',
            plan: steps(['completed', 'completed', 'completed', 'failed']),
          },
        }}
      />
    </Stack>
  )
}

/** Goal renderer(goal:create / goal:update):active / complete / blocked 三态。 */
export function GoalToolCardExample(): ReactElement {
  const goal = (status: string, objective: string, error?: string): ToolCallBlockType => ({
    type: 'tool-call',
    toolCallId: `goal-${status}`,
    toolName: 'goal:create',
    args: { objective, status },
    error: toOptional(error),
  })

  return (
    <Stack gap="sm">
      <ToolCard compact={false} block={goal('active', '把新手引导流程跑通端到端')} />
      <ToolCard compact={false} block={goal('complete', '把新手引导流程跑通端到端')} />
      <ToolCard compact={false} block={goal('blocked', '把新手引导流程跑通端到端', '缺少测试账号,无法继续')} />
    </Stack>
  )
}

/** FileChange renderer(project:edit / write 等):success / running / rejected / no-change 四态。 */
export function FileChangeToolCardExample(): ReactElement {
  return (
    <Stack gap="sm">
      <ToolCard
        block={{
          type: 'tool-call',
          toolCallId: 'edit-ok',
          toolName: 'project:edit',
          args: { path: 'src/greeter.ts' },
          result: {
            transactionId: 'tx-1',
            changedFiles: ['src/greeter.ts', 'src/index.ts'],
            patches: [{ path: 'src/greeter.ts' }, { path: 'src/index.ts' }],
            changed: true,
          },
        }}
      />
      <ToolCard
        block={{
          type: 'tool-call',
          toolCallId: 'edit-run',
          toolName: 'project:edit',
          args: { path: 'src/greeter.ts' },
          isRunning: true,
        }}
      />
      <ToolCard
        block={{
          type: 'tool-call',
          toolCallId: 'edit-reject',
          toolName: 'project:edit',
          args: { path: 'src/greeter.ts' },
          result: { transactionId: 'tx-2', approved: false, blocked: true, changedFiles: [] },
        }}
      />
      <ToolCard
        block={{
          type: 'tool-call',
          toolCallId: 'edit-nochange',
          toolName: 'project:edit',
          args: { path: 'src/greeter.ts' },
          result: { transactionId: 'tx-3', changed: false, changedFiles: [] },
        }}
      />
    </Stack>
  )
}

/** compact(合并行) 与 full(展开卡) 两种密度形态。 */
export function ToolCardDensityExample(): ReactElement {
  const block: ToolCallBlockType = {
    type: 'tool-call',
    toolCallId: 'density',
    toolName: 'bash',
    args: { command: 'bun run scripts:run typecheck:web' },
    result: {
      command: 'bun run scripts:run typecheck:web',
      cwd: '/workspace',
      exitCode: 0,
      stdout: 'tsc --noEmit -p tsconfig.web.json --composite false',
      stderr: '',
      durationMs: 8100,
      timedOut: false,
      truncated: false,
      success: true,
    },
  }

  return (
    <Stack gap="sm">
      <ToolCard block={block} compact />
      <ToolCard block={block} compact={false} />
    </Stack>
  )
}
