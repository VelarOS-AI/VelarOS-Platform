/**
 * 验收测试与实现测试共用的假对象：一块假桌面（主屏在虚拟桌面上的原点为负——多显示器的常态，本单元要是自己换算坐标一眼就看得出来），
 * 经真的能力端口挂上 `velaros:computer` 的五个操作；交给运行时的每次移动、点击、输入、按键与交出的图都记下来。
 * 还有照生成的声明跑一段模型程序的代码面会话。放在 spec 下，因为验收测试依赖它们；实现测试也从这里取。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { AppError } from '@velaros-ai/core/error'
import type { CapabilityOperationContext } from '@velaros-ai/script'
import {
  codeProgramChecker,
  createCapabilityPort,
  createCodeSurfaceSession,
  nodeSubprocessCodeRunner,
} from '@velaros-ai/script'
import type { ImageAttachment } from '@velaros-ai/velaros/images'

import type {
  ComputerAvailability,
  ComputerClickInput,
  ComputerClickOptions,
  ComputerDragInput,
  ComputerElementInput,
  ComputerElementValueInput,
  ComputerKeyInput,
  ComputerKeyStateInput,
  ComputerMouseDownInput,
  ComputerMouseUpInput,
  ComputerMoveOptions,
  ComputerOperationContext,
  ComputerPoint,
  ComputerRecordInput,
  ComputerScrollInput,
  ComputerSpacePort,
  ComputerTreeInput,
  ComputerTypeInput,
  ComputerWindowInput,
} from '../index'
import { computerOperations } from '../index'

/** 假桌面上那张截图的 snapshotId。 */
export const SnapshotId = 'screen_spec_snapshot_01'

/** 主屏在虚拟桌面上的几何：原点为负，截图坐标加上原点才是全局坐标。 */
export const Display = Object.freeze({
  displayId: 7,
  width: 1_920,
  height: 1_080,
  scaleFactor: 1,
  originX: -1_920,
  originY: 120,
})

/** 交给运行时的一次移动或点击：模型给的坐标与选项原样记下。 */
export interface RecordedPointer<TOptions> {
  x: number
  y: number
  options?: TOptions
}

/**
 * 一块假桌面：`available` 给了就按它回答可用性；运行时只认 `acceptedSnapshotId` 这张截图（缺省是 SnapshotId），
 * 别的截图绑定一律按过期拒绝，像 helper 那样；`attach` 为 false 时宿主没有交图通道。
 */
export function computerDesk(
  options: { available?: ComputerAvailability; acceptedSnapshotId?: string; attach?: boolean } = {}
) {
  const moves: Array<RecordedPointer<ComputerMoveOptions>> = []
  const clicks: Array<RecordedPointer<ComputerClickOptions>> = []
  const typed: string[] = []
  const pressed: string[] = []
  const attached: ImageAttachment[] = []
  const accepted = options.acceptedSnapshotId ?? SnapshotId
  let availabilityChecks = 0
  const stale = (snapshotId: string) => {
    if (snapshotId !== accepted)
      throw new AppError(
        'VALIDATION',
        '这张截图已经过期：主屏、分辨率、缩放或原点变过了，旧坐标作废。（screen_snapshot_stale）'
      )
  }
  const port: ComputerSpacePort = {
    capabilities: async () => ({
      platform: 'test',
      windows: true,
      uiTree: true,
      recording: true,
      captureMode: 'visible-region',
      limitations: [],
    }),
    windows: async () => [],
    screenshotWindow: async () => {
      throw new Error('This test desktop has no screenshotWindow implementation')
    },
    focusWindow: async () => {
      throw new Error('This test desktop has no focusWindow implementation')
    },
    scroll: async () => {
      throw new Error('This test desktop has no scroll implementation')
    },
    drag: async () => {
      throw new Error('This test desktop has no drag implementation')
    },
    mouseDown: async () => {
      throw new Error('This test desktop has no mouseDown implementation')
    },
    mouseUp: async () => ({ held: [], released: [], leaseMs: 5000 }),
    keyDown: async () => {
      throw new Error('This test desktop has no keyDown implementation')
    },
    keyUp: async () => ({ held: [], released: [], leaseMs: 5000 }),
    releaseInputs: async () => ({ held: [], released: [], leaseMs: 5000 }),
    uiTree: async () => {
      throw new Error('This test desktop has no uiTree implementation')
    },
    invokeElement: async () => {
      throw new Error('This test desktop has no invokeElement implementation')
    },
    setElementValue: async () => {
      throw new Error('This test desktop has no setElementValue implementation')
    },
    record: async () => {
      throw new Error('This test desktop has no record implementation')
    },
    ensureAvailable: async () => {
      availabilityChecks += 1
      return options.available ?? { available: true, reason: 'available', detail: null }
    },
    screenshot: async () => ({
      base64: Buffer.from('desktop-pixels').toString('base64'),
      format: 'jpeg',
      snapshotId: SnapshotId,
      width: Display.width,
      height: Display.height,
      displayWidth: Display.width,
      displayHeight: Display.height,
      ...Display,
    }),
    mouseMove: async (x, y, moveOptions) => {
      if (moveOptions?.coordinateSpace === 'primary-display') {
        stale(moveOptions.snapshotId)
        moves.push({ x, y, options: moveOptions })
        return {
          x: Display.originX + x,
          y: Display.originY + y,
          coordinateSpace: 'primary-display',
          displayId: Display.displayId,
          snapshotId: moveOptions.snapshotId,
        }
      }
      moves.push({ x, y, options: moveOptions })
      return { x, y, coordinateSpace: 'global' }
    },
    click: async (x, y, clickOptions) => {
      const button = clickOptions?.button ?? 'left'
      const count = clickOptions?.count ?? 1
      if (clickOptions?.coordinateSpace === 'primary-display') {
        stale(clickOptions.snapshotId)
        clicks.push({ x, y, options: clickOptions })
        return {
          x: Display.originX + x,
          y: Display.originY + y,
          button,
          count,
          coordinateSpace: 'primary-display',
          displayId: Display.displayId,
          snapshotId: clickOptions.snapshotId,
        }
      }
      clicks.push({ x, y, options: clickOptions })
      return { x, y, button, count, coordinateSpace: 'global' }
    },
    typeText: async (text) => {
      typed.push(text)
      return { typed: text.length }
    },
    key: async (keys) => {
      pressed.push(keys)
      return { pressed: keys.split('+') }
    },
  }
  const context: ComputerOperationContext = {
    abortSignal: new AbortController().signal,
    computer: port,
  }
  if (options.attach !== false) context.attachImage = (image) => attached.push(image)
  /** 代码面宿主给每次调用装的上下文：同一个端口，图交给代码面的图片通道。 */
  const hostContext = (call: CapabilityOperationContext): ComputerOperationContext => {
    const scoped: ComputerOperationContext = {
      abortSignal: call.signal ?? new AbortController().signal,
      computer: port,
    }
    if (options.attach !== false)
      scoped.attachImage = (image) => call.attach({ type: 'image-data', ...image })
    return scoped
  }
  const capabilities = createCapabilityPort({
    computer: {
      capabilities: (_input, call) => computerOperations.capabilities(hostContext(call)),
      windows: (_input, call) => computerOperations.windows(hostContext(call)),
      screenshotWindow: (input, call) =>
        computerOperations.screenshotWindow(input as ComputerWindowInput, hostContext(call)),
      focusWindow: (input, call) =>
        computerOperations.focusWindow(input as ComputerWindowInput, hostContext(call)),
      scroll: (input, call) =>
        computerOperations.scroll(input as ComputerScrollInput, hostContext(call)),
      drag: (input, call) => computerOperations.drag(input as ComputerDragInput, hostContext(call)),
      mouseDown: (input, call) =>
        computerOperations.mouseDown(input as ComputerMouseDownInput, hostContext(call)),
      mouseUp: (input, call) =>
        computerOperations.mouseUp(input as ComputerMouseUpInput, hostContext(call)),
      keyDown: (input, call) =>
        computerOperations.keyDown(input as ComputerKeyStateInput, hostContext(call)),
      keyUp: (input, call) =>
        computerOperations.keyUp(input as ComputerKeyStateInput, hostContext(call)),
      releaseInputs: (_input, call) => computerOperations.releaseInputs(hostContext(call)),
      uiTree: (input, call) =>
        computerOperations.uiTree(input as ComputerTreeInput, hostContext(call)),
      invokeElement: (input, call) =>
        computerOperations.invokeElement(input as ComputerElementInput, hostContext(call)),
      setElementValue: (input, call) =>
        computerOperations.setElementValue(input as ComputerElementValueInput, hostContext(call)),
      record: (input, call) =>
        computerOperations.record(input as ComputerRecordInput, hostContext(call)),
      screenshot: (_input, call) => computerOperations.screenshot(hostContext(call)),
      move: (input, call) => computerOperations.move(input as ComputerPoint, hostContext(call)),
      click: (input, call) =>
        computerOperations.click(input as ComputerClickInput, hostContext(call)),
      typeText: (input, call) =>
        computerOperations.typeText(input as ComputerTypeInput, hostContext(call)),
      key: (input, call) => computerOperations.key(input as ComputerKeyInput, hostContext(call)),
    },
  })
  const images: unknown[] = []
  /** 像模型的程序那样调一次：成功交回返回值，失败抛带 code 的错误（程序看得到的就这两样）。入参与返回值都过一遍 JSON。 */
  const call = async (operation: string, input: unknown = {}): Promise<any> => {
    const outcome = await capabilities.invoke({
      namespace: 'computer',
      operation,
      input: JSON.parse(JSON.stringify(input)),
    })
    images.push(...(outcome.attachments ?? []))
    if (outcome.error)
      throw Object.assign(new Error(outcome.error.message), { code: outcome.error.code })
    return outcome.value === undefined ? undefined : JSON.parse(JSON.stringify(outcome.value))
  }
  return {
    port,
    context,
    capabilities,
    call,
    moves,
    clicks,
    typed,
    pressed,
    attached,
    images,
    availabilityChecks: () => availabilityChecks,
  }
}

/** 等一个调用失败，交出它的码与说明。 */
export async function failureOf(
  call: Promise<unknown>
): Promise<{ code: string; message: string }> {
  try {
    await call
  } catch (error) {
    const failure = error as { code?: string; message?: string }
    return {
      code: failure.code ?? AppError.from(error).code,
      message: failure.message ?? String(error),
    }
  }
  throw new Error('应当失败，却成功了')
}

// ── 代码面 ──────────────────────────────────────────────────────

/** 模型这一轮读到的 `velaros:computer` 声明：就是提交进仓的那份生成物：程序照它核对 import，代码模版照它过类型检查。 */
export const ComputerDeclarations = readFileSync(
  fileURLToPath(new URL('../../../../baselines/script/computer.d.ts', import.meta.url)),
  'utf8'
)

/** 这一轮授给程序的模块：只有 `computer` 一个命名空间。 */
const Granted = [{ namespace: 'computer', declarations: ComputerDeclarations }]

/** 代码模版照生成的声明做完整类型检查、不执行：交回诊断，过了就是空的。模型交的程序只查语法，不走这里。 */
export function typecheckTemplate(source: string) {
  const checked = codeProgramChecker.typecheck({ source, granted: Granted })
  return checked.ok ? [] : checked.diagnostics
}

/** 让一段真程序过语法检查，再在隔离里跑完：交出程序的结果与跟在结果旁边交给模型的图。 */
export async function runModelProgram(
  desk: ReturnType<typeof computerDesk>,
  source: string,
  timeoutMs = 20_000
) {
  const session = createCodeSurfaceSession({
    checker: codeProgramChecker,
    runner: nodeSubprocessCodeRunner,
    capabilities: desk.capabilities,
  })
  const outcome = await session.submit({ program: { source }, granted: Granted, timeoutMs })
  if (!outcome.checked) {
    const why =
      'needsModules' in outcome
        ? `要先补模块 ${outcome.needsModules.join(', ')}`
        : JSON.stringify(outcome.check.diagnostics)
    throw new Error(`程序没过检查：${why}`)
  }
  return { result: outcome.result, attachments: outcome.attachments ?? [] }
}
