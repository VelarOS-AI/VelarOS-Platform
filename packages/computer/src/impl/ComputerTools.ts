/**
 * 桌面控制的五个模型面工具：定义、能力档、分组，以及作为能力服务挂进 VelarOS 内核。
 *
 * 这里只放定义：每个工具的 execute 一行交给 `ComputerInputOperations`，可用性门禁、坐标换算与
 * 回执投影都在那边。工具说明与 schema 里的上限一律引 `contract/constants.ts`，改一处模型看到的跟着变。
 */

import { z } from 'zod'

import type { ToolCapabilitySchema } from '@velaros-ai/agent/contracts'
import { isPresent } from '@velaros-ai/core'
import type {
  KernelModuleDefinition,
} from '@velaros-ai/kernel'
import {
  kernelModules,
} from '@velaros-ai/kernel'
import type {
  CapabilityToken,
} from '@velaros-ai/kernel/contracts'
import {
  KernelVersionAxes,
} from '@velaros-ai/kernel/contracts'
import {
  renderParameterDescription as parameterDescription,
  toolDescriptions,
  toolKernelModules,
} from '@velaros-ai/tool-contract'

import {
  ComputerCapabilityId,
  ComputerInputLimits,
  ComputerKernelModuleId,
  ComputerKernelModuleVersion,
  ComputerToolCategoryId,
} from '../contract/constants.js'
import type { ComputerCapabilityService, ComputerToolCollection } from '../contract/provides.js'
import type { CreateComputerKernelModuleOptions } from '../contract/requires.js'
import type { ComputerClickOptions, ComputerMoveOptions } from '../types/computer.js'
import type { ComputerClickInput, ComputerPointInput, ComputerToolCapabilitySchema } from '../types/tool.js'
import { computerHostPortFromRuntime, defineComputerTool } from '../utils/tool.js'

import { computerInputOperations } from './ComputerInputOperations.js'
import { ComputerSidecarManager } from './ComputerSidecarManager.js'

/**
 * 只读档：截图与屏幕几何。不动鼠标键盘，所以并发安全，风险低于控制档。
 */
export const ComputerObserveCapability: ToolCapabilitySchema = {
  effectKind: 'read',
  readScopes: ['system'],
  canReadArbitrarySource: true,
  concurrency: 'safe',
  reason: '观察桌面画面（截图与屏幕几何）。',
}

/**
 * 控制档：对任意应用的鼠标键盘控制，风险最高。
 *
 * `process.execution: 'dangerous'` 只是给检索与展示用的风险标注，不触发逐次审批。
 * 授权口径（「启用桌面控制这件事本身即授权，之后只剩操作系统权限那道门」）是产品决定，
 * 写在 `MODULE.md` 的「失败语义」与宿主的设置说明里，不写进工具说明——模型据此做不了任何决定。
 */
export const ComputerControlCapability: ComputerToolCapabilitySchema = {
  effectKind: 'execute',
  readScopes: ['system'],
  writeScopes: ['system'],
  process: { execution: 'dangerous' },
  canReadArbitrarySource: true,
  concurrency: 'unsafe',
  metadata: {
    canMutateProject: false,
  },
  reason: '控制桌面输入（鼠标与键盘）。',
}

const primaryDisplayPointShape = {
  x: z.number().int().min(0).max(ComputerInputLimits.coordinateBound).describe(
    parameterDescription({ description: '主屏截图内的逻辑 x 坐标。' })
  ),
  y: z.number().int().min(0).max(ComputerInputLimits.coordinateBound).describe(
    parameterDescription({ description: '主屏截图内的逻辑 y 坐标。' })
  ),
  coordinateSpace: z.literal('primary-display').default('primary-display').describe(
    parameterDescription({
      description: '默认 primary-display：坐标相对 computer:screenshot 左上角。',
    })
  ),
}

const globalPointShape = {
  x: z.number().int().min(-ComputerInputLimits.coordinateBound).max(ComputerInputLimits.coordinateBound).describe(
    parameterDescription({ description: '虚拟桌面的全局逻辑 x 坐标，可为负数。' })
  ),
  y: z.number().int().min(-ComputerInputLimits.coordinateBound).max(ComputerInputLimits.coordinateBound).describe(
    parameterDescription({ description: '虚拟桌面的全局逻辑 y 坐标，可为负数。' })
  ),
  coordinateSpace: z.literal('global').describe(
    parameterDescription({ description: '显式全局虚拟桌面坐标。' })
  ),
}

const snapshotIdSchema = z
  .string()
  .min(ComputerInputLimits.snapshotIdMinChars)
  .max(ComputerInputLimits.snapshotIdMaxChars)
  .regex(/^[A-Za-z0-9_-]+$/)
  .describe(
    parameterDescription({
      description: 'computer:screenshot 返回的不透明 snapshotId；必须原样传回。',
    })
  )

const clickButtonSchema = z
  .enum(['left', 'right', 'middle'])
  .optional()
  .describe(parameterDescription({ description: '鼠标按键，默认 left。' }))

const clickCountSchema = z
  .number()
  .int()
  .min(1)
  .max(ComputerInputLimits.clickCount)
  .optional()
  .describe(parameterDescription({ description: '点击次数，双击传 2。默认 1。' }))

const computerPointSchema = z.union([
  z.object({ ...primaryDisplayPointShape, snapshotId: snapshotIdSchema }).strict(),
  z.object(globalPointShape).strict(),
])

/** 截取主显示器，供模型通过画面定位界面元素。 */
const computerScreenshot = defineComputerTool<Record<string, never>>({
  name: 'computer:screenshot',
  role: 'inspect',
  summary: '截取桌面主屏幕，用于定位原生应用 UI。',
  suitable: ['执行桌面点击/输入前确认界面并获取坐标。'],
  forbidden: ['网页内容用 browser 工具，不要用桌面截图替代。'],
  usage: ['无需参数；返回的 snapshotId 要原样传给随后基于该截图坐标执行的 computer:move 与 computer:click。'],
  examples: [{}],
  notes: [
    '返回屏幕几何与 snapshotId，截图本身作为图片交给你。',
    '截图为主显示器局部逻辑坐标；图上量出的像素可直接用于 computer:move、computer:click，同时必须携带本次返回的 snapshotId。',
    '动作执行前 helper 会校验 snapshotId 和当前主屏布局；主屏切换、分辨率、缩放或原点变化时会拒绝旧坐标并要求重新截图。',
  ],
  schema: z.object({}),
  permissions: ['screen:capture'],
  capabilities: ComputerObserveCapability,
  requiredModelInputModalities: ['image'],
  isConcurrencySafe: () => true,
  execute: async (_args, ctx) => computerInputOperations.screenshot(ctx),
})

/** 将光标移动到指定坐标，不执行点击。 */
const computerMove = defineComputerTool<ComputerPointInput>({
  name: 'computer:move',
  role: 'control',
  summary: '移动鼠标到屏幕坐标（不点击）。',
  suitable: ['需要悬停某处但不点击。'],
  forbidden: ['点击用 computer:click；不要省略或复用其他截图的 snapshotId。'],
  usage: [
    '移动到截图内位置：传 x、y 和同一次 computer:screenshot 返回的 snapshotId。',
    '显式全局坐标传 coordinateSpace=global，且不要传 snapshotId。',
  ],
  examples: [{ x: 640, y: 400, snapshotId: 'screen_example_snapshot_01' }],
  notes: ['helper 会在真实移动前校验截图绑定；主屏或布局变化后旧 snapshotId 会被拒绝，请重新截图。'],
  schema: computerPointSchema,
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => computerInputOperations.move(input, ctx),
})

/** 在指定坐标点击，可配置鼠标按键与点击次数。 */
const computerClick = defineComputerTool<ComputerClickInput>({
  name: 'computer:click',
  role: 'control',
  summary: '在屏幕坐标点击桌面或原生应用。',
  suitable: ['点击桌面按钮、菜单、输入框等元素。'],
  forbidden: ['网页内点击用 browser 工具；不要省略或复用其他截图的 snapshotId。'],
  usage: [
    '点击截图内位置：传 x、y 和同一次 computer:screenshot 返回的 snapshotId。',
    '可选 button 和 count（双击传 2）；显式全局坐标传 coordinateSpace=global，且不要传 snapshotId。',
  ],
  examples: [{ x: 756, y: 342, snapshotId: 'screen_example_snapshot_01' }],
  notes: [
    'helper 会在真实点击前校验截图绑定；主屏或布局变化后旧 snapshotId 会被拒绝，请重新截图。',
  ],
  schema: z.union([
    z.object({
      ...primaryDisplayPointShape,
      snapshotId: snapshotIdSchema,
      button: clickButtonSchema,
      count: clickCountSchema,
    }).strict(),
    z.object({
      ...globalPointShape,
      button: clickButtonSchema,
      count: clickCountSchema,
    }).strict(),
  ]),
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async (input, ctx) => computerInputOperations.click(input, ctx),
})

/** 向当前聚焦元素输入原样文本。 */
const computerType = defineComputerTool<{ text: string }>({
  name: 'computer:type',
  role: 'control',
  summary: '在当前焦点处输入文本。',
  suitable: ['向已聚焦的输入框/编辑器输入文字。'],
  forbidden: ['组合键用 computer:key。'],
  usage: ['先点击获取焦点，再传 text。'],
  examples: [{ text: 'hello world' }],
  schema: z.object({
    text: z
      .string()
      .min(1)
      .max(ComputerInputLimits.typeTextChars)
      .describe(parameterDescription({ description: '要输入的文本。' })),
  }),
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async ({ text }, ctx) => computerInputOperations.typeText(text, ctx),
})

/** 按下单键或组合键，例如 `cmd+a`、`enter`。 */
const computerKey = defineComputerTool<{ keys: string }>({
  name: 'computer:key',
  role: 'control',
  summary: '按下按键或组合键。',
  suitable: ['发送 Enter、Esc、Tab 或 cmd/ctrl 快捷键。'],
  forbidden: ['普通文本用 computer:type。'],
  usage: ['传按键序列，用 + 连接。'],
  examples: [{ keys: 'enter' }, { keys: 'cmd+a' }],
  schema: z.object({
    keys: z
      .string()
      .min(1)
      .max(ComputerInputLimits.keyChordChars)
      .describe(
        parameterDescription({
          description: '按键序列，组合键用 + 连接。',
          usage: ['示例：enter、esc、tab、cmd+a、ctrl+c。'],
        })
      ),
  }),
  permissions: ['input:control'],
  capabilities: ComputerControlCapability,
  isConcurrencySafe: () => false,
  execute: async ({ keys }, ctx) => computerInputOperations.key(keys, ctx),
})

/**
 * Computer Use 工具集合（OS 级桌面控制）。
 *
 * 截图是只读档；移动、点击、输入、按键是高风险控制档。整组类别默认关闭，需要显式打开。
 */
export const computerTools: ComputerToolCollection = toolDescriptions.forCategory(
  {
    'computer:screenshot': computerScreenshot,
    'computer:move': computerMove,
    'computer:click': computerClick,
    'computer:type': computerType,
    'computer:key': computerKey,
  },
  ComputerToolCategoryId
)

// ── 作为能力服务挂进 VelarOS 内核 ──────────────────────

/** 桌面控制能力服务在内核里的身份令牌，宿主按它取到服务。 */
export const ComputerCapability: CapabilityToken<ComputerCapabilityService> =
  kernelModules.token<ComputerCapabilityService>(ComputerCapabilityId)

/**
 * 创建桌面控制的内核模块：激活时把五个工具登记成能力服务。
 *
 * 操作名就是工具名，入参用工具自己的 schema 严格解析——内核面与模型面因此是同一套契约，
 * 不再有第二份手写的入参门（曾经两边上限不一致，`computer:move` 经内核调用必失败）。
 * 宿主没给上下文解析器时，用它注入或模块自造的运行时兜一份上下文出来，桌面控制照样按名可调。
 */
export function createComputerKernelModule(
  options: CreateComputerKernelModuleOptions = {},
): KernelModuleDefinition {
  return kernelModules.define({
    manifest: {
      id: ComputerKernelModuleId,
      version: ComputerKernelModuleVersion,
      apiVersion: KernelVersionAxes.moduleApi,
      provides: [ComputerCapability],
      requires: [],
      optionalRequires: [],
      permissions: ['process:exec', 'screen:capture', 'input:control'],
      isolation: 'in-process',
    },
    activate(context) {
      const ownsRuntime = !isPresent(options.runtime) || !!options.disposeInjectedRuntime
      const runtime = options.runtime ?? new ComputerSidecarManager(options.sidecar)
      const resolveContext = options.resolveContext
        ?? ((_scope, signal: AbortSignal) => ({
          abortSignal: signal,
          computer: computerHostPortFromRuntime(runtime),
        }))
      const callable = kernelModules.callable(
        toolKernelModules.callableOperations(computerTools, resolveContext, { label: '桌面控制' }),
      )
      const service: ComputerCapabilityService = Object.freeze({
        ...callable,
        tools: Object.freeze({ ...computerTools }),
        isReady: () => runtime.isReady(),
        ensureAvailable: () => runtime.ensureAvailable(),
        screenSize: () => runtime.screenSize(),
        screenshot: () => runtime.screenshot(),
        mouseMove: (x: number, y: number, moveOptions?: ComputerMoveOptions) =>
          runtime.mouseMove(x, y, moveOptions),
        click: (x: number, y: number, clickOptions?: ComputerClickOptions) =>
          runtime.click(x, y, clickOptions),
        typeText: (text: string) => runtime.typeText(text),
        key: (keys: string) => runtime.key(keys),
        dispose: () => runtime.dispose(),
      })
      context.registerService(ComputerCapability, service)

      return {
        dispose() {
          if (ownsRuntime) runtime.dispose()
        },
      }
    },
  })
}
