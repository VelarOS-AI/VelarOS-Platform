import { type z } from 'zod'

import {
  type AppliedAdjustment,
  buildAppliedAdjustments,
} from '@velaros-ai/core/utils/ForgivingSchema'

import type { GameInputStep, GameRuntimeQuery } from '../core/index.js'

import {
  GameInputCapability,
  GameManifestEditCapability,
  GameObserveCapability,
  GameRunCapability,
  GameScreenshotCapability,
} from './Capabilities.js'
import { GameToolName } from './Names.js'
import {
  GameInputSchema,
  GameQueryStateSchema,
  GameRunSchema,
  GameSceneEditSchema,
  GameScreenshotSchema,
  GameStopSchema,
  ValidGameInputStepSchema,
} from './Schemas.js'
import { defineGameTool, type GameToolContext } from './Types.js'

class GameToolStateError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'GameToolStateError'
  }
}

function isGameProjectAvailable(context: GameToolContext): boolean {
  return context.game.isProjectAvailable()
}

function isGameRuntimeAvailable(context: GameToolContext): boolean {
  return isGameProjectAvailable(context) && context.game.runtime.isAvailable()
}

function requireRunning(context: GameToolContext): void {
  if (context.game.runtime.isRunning()) return
  throw new GameToolStateError('游戏尚未运行；请先调用 game_run，成功后再执行此操作。')
}

export const gameSceneEditTool = defineGameTool<
  z.output<typeof GameSceneEditSchema>
>({
  name: GameToolName.sceneEdit,
  role: 'edit',
  summary: '用语义操作安全修改游戏工程、场景、prefab 或资产清单。',
  suitable: [
    '需要新增、删除或调整场景实体、组件、资产、工程设置时。',
    '需要重命名实体并同步继承场景中的引用时。',
  ],
  forbidden: [
    '不要用它编辑 TypeScript 玩法代码；代码仍使用工作区编辑工具。',
    '不要把整份 JSON 文本塞进 values 来绕过语义操作。',
  ],
  protocol: [
    '先选择 target，再提交同一目标上的 operations；需要预览时传 dryRun=true。',
    'scene 的组件操作必须带 entityId；prefab 的组件操作不带 entityId。',
  ],
  usage: [
    'set_entity 是 upsert + merge patch；显式 null 清除字段，数组整体替换。',
    '空 operations 是成功的 no-op，不会重写文件。',
  ],
  examples: [
    {
      target: 'scene:level-1',
      operations: [
        {
          action: 'set_entity',
          entityId: 'player',
          from: 'prefab:player',
          components: { transform: { position: { x: 64, y: 320 } } },
        },
      ],
      reason: '放置玩家出生点',
    },
    {
      target: 'prefab:player',
      operations: [
        {
          action: 'set_component',
          component: 'body',
          values: { kind: 'dynamic', layer: 'player' },
        },
      ],
      dryRun: true,
    },
  ],
  notes: [
    '写入由宿主提供的工程根受限、revision 原子文档端口完成。',
    '全部修改在写盘前重新解析并验证引用、继承与碰撞层。',
  ],
  schema: GameSceneEditSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: GameManifestEditCapability,
  hideWhenUnavailable: true,
  isAvailable: (context) =>
    isGameProjectAvailable(context) && context.game.editor.isAvailable(),
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    return context.game.editor.edit(input)
  },
})

export const gameRunTool = defineGameTool<z.output<typeof GameRunSchema>>({
  name: GameToolName.run,
  role: 'control',
  summary: '经审批启动或重启游戏 dev server，并等待运行时可交互。',
  suitable: [
    '需要运行游戏、切换入口场景或在修改后重启并读取首屏诊断时。',
  ],
  forbidden: [
    '不要用它执行任意 shell 命令；命令只来自已打开工程的 game.project.json。',
    '不要在只需要读取清单时启动运行时。',
  ],
  protocol: [
    '省略 scene 时使用 project.entryScene；已在同一场景运行时默认幂等复用。',
    'dev server 命令必须通过宿主 process:exec 审批端口，工具自身不能直接 spawn。',
  ],
  usage: [
    '需要强制重启时传 restart=true；timeoutMs 会钳制到 1000..180000。',
  ],
  examples: [{}, { scene: 'scene:level-1', restart: true, timeoutMs: 60_000 }],
  notes: [
    'V0 始终等待可交互状态，不暴露无法形成闭环的 waitForReady=false 分支。',
    '宿主没有注入获批进程端口时默认拒绝。',
  ],
  schema: GameRunSchema,
  permissions: ['fs:read', 'process:exec', 'browser:control'],
  capabilities: GameRunCapability,
  hideWhenUnavailable: true,
  isAvailable: isGameRuntimeAvailable,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    const {
      appliedAdjustments: schemaAdjustments,
      ...request
    } = input
    const {
      appliedAdjustments: runtimeAdjustments,
      ...result
    } = await context.game.runtime.run(request)
    return {
      ...result,
      ...buildAppliedAdjustments([
        ...(runtimeAdjustments ?? []),
        ...(schemaAdjustments as readonly AppliedAdjustment[]),
      ]),
    }
  },
})

export const gameStopTool = defineGameTool<z.output<typeof GameStopSchema>>({
  name: GameToolName.stop,
  role: 'control',
  summary: '停止当前游戏 dev server；未运行时安全地返回 no-op。',
  suitable: ['完成验证、需要释放 dev server，或启动链异常后需要收尾时。'],
  forbidden: ['不要用它终止游戏工程之外的进程。'],
  protocol: ['默认优雅停止；仅在进程无法退出时传 force=true。'],
  usage: ['无需参数即可停止；重复调用是幂等的。'],
  examples: [{}, { force: true }],
  notes: ['只操作当前 GameRuntimePort 拥有的进程句柄。'],
  schema: GameStopSchema,
  permissions: ['process:exec'],
  capabilities: GameRunCapability,
  hideWhenUnavailable: true,
  isAvailable: isGameRuntimeAvailable,
  isConcurrencySafe: () => false,
  execute: async ({ force }, context) => {
    context.abortSignal.throwIfAborted()
    return context.game.runtime.stop(force)
  },
})

export const gameScreenshotTool = defineGameTool<
  z.output<typeof GameScreenshotSchema>
>({
  name: GameToolName.screenshot,
  role: 'inspect',
  summary: '截取当前游戏画布并保存为工作区产物。',
  suitable: [
    '需要观察真实画面、碰撞调试层或修改前后视觉差异时。',
  ],
  forbidden: [
    '不要在游戏未运行时调用；先 game_run。',
    '不要传文件路径；产物位置由宿主生成，避免路径注入。',
  ],
  protocol: [
    '可选择 region、等待若干帧并决定是否包含 debug overlay。',
  ],
  usage: [
    'label 只用于稳定产物名提示；region 坐标相对游戏画布。',
  ],
  examples: [{ label: 'level-1-ready' }, { overlay: true, waitFrames: 4 }],
  notes: [
    'V0 保留独立工具名，但实现只是 GameRuntimePort 的薄转发，不复制浏览器截图逻辑。',
  ],
  schema: GameScreenshotSchema,
  permissions: ['browser:control', 'screen:capture', 'fs:write'],
  capabilities: GameScreenshotCapability,
  hideWhenUnavailable: true,
  isAvailable: isGameRuntimeAvailable,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    requireRunning(context)
    return context.game.runtime.screenshot(input)
  },
})

export const gameQueryStateTool = defineGameTool<
  z.output<typeof GameQueryStateSchema>
>({
  name: GameToolName.queryState,
  role: 'inspect',
  summary: '从同一帧的运行时查询场景、实体、错误或性能状态。',
  suitable: [
    '需要验证游戏是否运行、实体组件是否变化、错误是否清零或性能是否稳定时。',
  ],
  forbidden: [
    '不要用它修改状态或执行任意页面脚本。',
    '不要无界读取实体或错误列表；使用 limit/offset 分页。',
  ],
  protocol: [
    '省略 select 时读取 scene；entities/errors 返回 total 与 nextOffset。',
  ],
  usage: [
    '读取单实体时传 select=entity 和 entityId，可用 components 收窄结果。',
  ],
  examples: [
    {},
    { select: 'entity', entityId: 'player', components: ['transform', 'body'] },
    { select: 'errors', limit: 20, offset: 0 },
  ],
  notes: [
    'V0 不增加独立 game_assert；查询保持单一真值，断言由调用方基于结构化结果完成。',
  ],
  schema: GameQueryStateSchema,
  permissions: ['browser:control'],
  capabilities: GameObserveCapability,
  hideWhenUnavailable: true,
  isAvailable: isGameRuntimeAvailable,
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    requireRunning(context)
    return context.game.runtime.query(input as GameRuntimeQuery)
  },
})

export const gameInputTool = defineGameTool<z.output<typeof GameInputSchema>>({
  name: GameToolName.input,
  role: 'control',
  summary: '向运行中的游戏注入逻辑动作、键盘或指针输入并回显应用结果。',
  suitable: [
    '需要验证跳跃、移动、点击或等待后的真实玩法状态变化时。',
  ],
  forbidden: [
    '不要用它控制游戏画布之外的应用或页面。',
    '不要传脚本或任意代码作为输入。',
  ],
  protocol: [
    '优先使用 press + logicalAction，让改键位不破坏验证；必要时再用原始键码。',
    '非法单步进入 droppedSteps，不让整个批次失败；空 steps 是成功 no-op。',
  ],
  usage: [
    'repeat 钳制到 1..20，settleFrames 钳制到 0..120；captureAfter 返回 scene 快照。',
  ],
  examples: [
    {
      steps: [
        { action: 'press', logicalAction: 'jump', ms: 80 },
        { action: 'wait', ms: 120 },
      ],
      settleFrames: 4,
      captureAfter: true,
    },
    { steps: [] },
  ],
  notes: [
    '坐标与键盘派发由宿主 RuntimePort 复用浏览器控制能力，本工具不实现第二套恢复逻辑。',
  ],
  schema: GameInputSchema,
  permissions: ['browser:control', 'input:control'],
  capabilities: GameInputCapability,
  hideWhenUnavailable: true,
  isAvailable: isGameRuntimeAvailable,
  isConcurrencySafe: () => false,
  execute: async ({ steps, repeat, settleFrames, captureAfter }, context) => {
    context.abortSignal.throwIfAborted()
    requireRunning(context)

    const validSteps: GameInputStep[] = []
    const originalIndexes: number[] = []
    const droppedSteps: Array<{ index: number; reason: string }> = []
    for (const [index, step] of steps.entries()) {
      const parsed = ValidGameInputStepSchema.safeParse(step)
      if (parsed.success) {
        validSteps.push(parsed.data)
        originalIndexes.push(index)
      } else {
        droppedSteps.push({
          index,
          reason: parsed.error.issues
            .map((issue) => issue.message)
            .join('; '),
        })
      }
    }

    if (validSteps.length === 0) return {
        appliedSteps: 0,
        droppedSteps,
        ...(captureAfter
          ? {
              stateAfter: await context.game.runtime.query({
                select: 'scene',
              }),
            }
          : {}),
      }

    const repetitions = repeat ?? 1
    const requestedWaitMs = validSteps.reduce(
      (total, step) => total + (
        step.action === 'wait'
          ? step.ms
          : step.action === 'press'
            ? step.ms ?? 50
            : 0
      ),
      0,
    ) * repetitions
    if (requestedWaitMs > 10_000) {
      throw new GameToolStateError(
        `game_input 的显式等待总时长为 ${requestedWaitMs}ms，超过单次 10000ms 上限；请拆批并在批次间 query。`,
      )
    }

    const result = await context.game.runtime.input(validSteps, {
      repeat,
      settleFrames,
      captureAfter,
    })
    return {
      ...result,
      droppedSteps: [
        ...droppedSteps,
        ...result.droppedSteps.map((dropped) => ({
          ...dropped,
          index: originalIndexes[dropped.index] ?? dropped.index,
        })),
      ].sort((left, right) => left.index - right.index),
    }
  },
})
