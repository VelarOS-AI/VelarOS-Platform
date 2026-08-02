import { type z } from 'zod'

import { isEmpty } from '@velaros-ai/core'
import {
  type AppliedAdjustment,
  buildAppliedAdjustments,
} from '@velaros-ai/core/utils/ForgivingSchema'

import { GameToolName } from '../contracts.js'
import type { GameInputStep, GameRuntimeQuery } from '../core/index.js'

import {
  GameInputCapability,
  GameManifestEditCapability,
  GameObserveCapability,
  GameRunCapability,
  GameScreenshotCapability,
} from './Capabilities.js'
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

/**
 * 「这条会话接入了游戏能力」—— **六个工具共用的唯一可用性门**。
 *
 * 判据（别再往里合取运行态，这是 2026-08 第二次事故的判决）：宿主的 `ctx.game` 是**每一轮
 * 只装配一次**的快照（`AgentRunner` 在轮开头调一次 `buildToolContext`）。把「工程已存在」或
 * 「运行时已就绪」合进 `isAvailable`，后果是同一轮里模型刚用 `game:scene_edit` 把工程建出来，
 * `game:run` 仍然整轮不在工具清单里，换页也过同一道门，于是「建完工程仍然跑不起来」。
 * 更糟的是可用性在轮内翻转还会与轮规划快照的失效判据（注册指纹，不含运行态）打架。
 *
 * 所以前置条件一律在**执行期**给可执行错误（见 `requireProject` / `requireRunning`），
 * 不由发现层隐身表达。真正该隐身的只有「用户没给工程根 / 扩展没启用」——那是用户动手的门，
 * 此时宿主注入的是不可用的编辑器端口，本函数如实回假。
 *
 * 端口选编辑器，是因为它是宿主注入游戏能力时必给的那一格（缺它连自举都做不了）。
 */
function isGameSessionAvailable(context: GameToolContext): boolean {
  return context.game.editor.isAvailable()
}

/**
 * 不可用时给发现层的原因 —— 这一档只剩「需要**用户**动手」，所以必须点名让用户做什么。
 *
 * 页表原来只有一句泛化的「工具注册存在，但当前运行态不可用。」，模型读到就判「此路不通」，
 * 于是去搜别的工具或退回 ui:show_widget 手搓（实测 8 次 tooling:map、59 秒）。
 */
function gameSessionUnavailableReason(): string {
  return '游戏能力未接入本会话：需要为该会话选一个工程根目录，并确认游戏 mod 已启用。这一步要用户在界面上完成，模型无法自行解除。'
}

/**
 * 六个 game 工具一律**不隐身**（2026-08 真机事故的判决，别再改回 true）。
 *
 * 事故形态：全部 `hideWhenUnavailable: true` + 可用性合取 `isProjectAvailable()`，空工程根上
 * 于是整族从发现层消失——模型在 game 空间连搜 8 次 `tooling:map`（game / 3d / scene / cube /
 * engine）零命中、耗时 59 秒，最后退回 `ui:show_widget` 手搓 Three.js。
 *
 * 判据：`hideWhenUnavailable` 的正当用途是「需要**用户**动手才能获得的能力」（computer-control
 * 要先装插件并授系统权限），隐身是为了不让模型对着自己解决不了的门空转。这里要动手的是模型
 * 自己（先建工程），正解因此是**留在发现层 + 给可执行原因**：模型看到「game 工具在、缺一个
 * 工程」，而不是得出「这个产品没有游戏能力」。
 *
 * 第二轮补齐（原来只做了一半）：留在发现层还不够——`isAvailable` 里合取「工程已存在」时，页表
 * 给出的信号是「不可用 / 无下一步」，语义上等于「此路不通」。现在六个工具共用
 * `isGameSessionAvailable` 这一道会话级门，工程前置改由执行期的 `requireProject` 给可执行
 * 错误；剩下真正需要用户动手的那一档（没绑工程根 / 扩展没启用）经工具自己的
 * `unavailableReason` 把原因带到页表上，而不是留一句泛化的「当前运行态不可用」。
 */
const GameToolHiddenWhenUnavailable = false

/**
 * 工程前置：缺工程清单时给**可执行**错误，而不是让工具从发现层消失。
 *
 * 错误正文必须包含自救动作（用哪个工具、传什么参数）：模型读到「不可用」只会去搜别的工具或
 * 退回手搓，读到「先用 game:scene_edit(target='project') 建工程」才会自举。
 */
function requireProject(context: GameToolContext): void {
  if (context.game.isProjectAvailable()) return
  throw new GameToolStateError(
    '工程根还没有 game.project.json：先调用 game:scene_edit(target="scene:<id>", operations=[…]) —— 它会一并建出工程清单、资产清单与这个入口场景，再重试本工具。'
  )
}

function requireRunning(context: GameToolContext): void {
  if (context.game.runtime.isRunning()) return
  throw new GameToolStateError('游戏尚未运行；请先调用 game:run，成功后再执行此操作。')
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
    'target 也是 upsert，但分两步：工程里已经有文件携带这个稳定 id（不管放在哪个目录、有没有被'
      + '声明）就采纳它并登记进 game.project.json；一个都没有才新建 scenes/<id>.scene.json'
      + '（prefab 落在 prefabs/<id>.prefab.json），工程还没有入口场景时一并设为 entryScene。',
    '空目录起步只要一次调用：target="scene:<id>" 会连 game.project.json 与资产清单一起建出来，'
      + '之后 game:run 即可用。不需要先手写任何 JSON。',
    'set_* 每一级都是 upsert + merge patch：target、实体、组件、资产都是不存在就创建'
      + '（set_component 带一个还不存在的 entityId 会先把该实体建出来）；'
      + '显式 null 清除字段，数组整体替换。',
    'remove_* / rename_* 反过来要求目标已存在，它们不会新建 target。判定按 operations 的先后'
      + '发生：批内在先的 set_* 已经把 target 建出来时，随后的 rename_entity / remove_entity 照样'
      + '成立；target 打错字而这一批以 remove_*/rename_* 开头时，你拿到的是'
      + '「找不到编辑目标 …。可用 scene：…」，照着改一次即可。',
    '空 operations = 「确保这份清单存在并被工程登记」：磁盘上已经有就登记进 game.project.json 并'
      + '规范化成 canonical 格式——已有内容一条不丢（真正未知的字段与 notes 原样保留、实体顺序不变），'
      + '但键序会按 canonical 重排，并把 schema 缺省字段显式写出来'
      + '（kind、extends: null、每个实体的 components: {}）；什么都没有就建一份空清单。',
    '写错名字/位置但**无歧义**的键会被归一到 canonical 形态，每一次都在 appliedAdjustments 里点名'
      + '（components.sprite / components.text → visual、components.collider → body、'
      + '组件写在实体块上 → 搬进 components、工程顶层的 pixelArt / canvasWidth / canvasHeight →'
      + ' runtime.* 、场景顶层的 gravity / background → meta）。canonical 那一格已经有值时**不归一**：'
      + '那是两种意图，warnings 会点名两边让你自己合并。',
    '形状也宽容：components 可以写成 ECS 风数组（每项用 type 或 component 指明组件名）；'
      + 'entities / assets / animation.clips 可以写成按 id（clips 按 name）分组的对象，'
      + '键会写进条目的 id/name。两种都在 appliedAdjustments 里点名。',
    '**解析器读不懂的形状一律当场失败，绝不静默丢掉再写回磁盘**：报错正文会说清「你写的是什么 / '
      + '这一格要的是什么 / 怎么改」，并且这次**零文件落盘**（磁盘一个字节都没动），改完重发即可。'
      + '所以 ok:true 就意味着落盘的内容里没有任何一条被悄悄扔掉。',
    'warnings 里写着「不会生效」的一律要改：那一项确实不会产生任何画面或行为。v0 的每一层'
      + '（含场景 / prefab / 资产清单的信封）都属于这一档——信封的已知键正是 entities / '
      + 'components / assets / extends / meta，把内容写在信封的错名键下同样什么都不会画。',
    'set_project 的数组是整体替换：重发 scenes / prefabs / assets 时漏掉一条 = 把那份文档摘出工程。'
      + '被摘掉的文件在磁盘上有内容时本次调用会被拒绝并点名它，空清单则放行并在 diffSummary 里'
      + '留一行 undeclared。只想改别的字段时就别重发这几项。',
    'set_extends 是 scene.extends / prefab.extends 的唯一写路径：target 决定种类，'
      + '传 scene:<slug> / prefab:<slug>（裸 slug 也收，会按 target 补前缀），传 null 清除继承。'
      + '继承成环或超过 4 层时报错正文会点名整条链，用它把环上任意一条改成 null 即可解开。',
    'target=project 在任何工程状态下都可用（工程清单本身读不出来除外，那一档会点名它）：'
      + '工程在你动手之前就已经坏掉时，编辑照常写入，那处破损随 warnings 原文送达而不是拦住你——'
      + '否则唯一能修拓扑的 set_project 会需要一个已经健康的工程。'
      + '读不出来的子清单会被排除在本次编辑之外（声明与文件都保留、绝不覆盖），'
      + '一条路径被两个角色声明时那条路径这次一个字节都不写。'
      + '但坏在哪一点上，触碰那一点本身仍然当场失败并点名文件：'
      + '同一个 id 有两份载体、资产清单或场景这次读不出来——那不是把工程锁死，'
      + '其余 target 与 set_project 照常可用，报错正文里就有出路。',
    'changedFiles 是这次真正落盘的权威清单，diffSummary 与它逐条对应：'
      + '写盘被保护挡下时会出一条 skipped write 行（说明这次对那份文件的改动没有生效，'
      + '照 warnings 修好冲突后重发即可），落盘却没有语义行的文件会补一条 wrote 行。'
      + '看到 skipped write 就别当成已经改好了。',
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
    {
      target: 'scene:level-1',
      operations: [{ action: 'set_extends', extends: null }],
      reason: '解开 scene:level-1 与 scene:base 之间的继承环',
    },
  ],
  notes: [
    '写入由宿主提供的工程根受限、revision 原子文档端口完成。',
    '全部修改在写盘前重新解析并验证引用、继承与碰撞层。',
    '新建与采纳都出现在 changedFiles 与 diffSummary（created: … / declared: … 行）里；'
      + '落点路径已被别的清单占用且 id 对不上、同一个稳定 id 在工程里有两份载体、'
      + '或声明指向 A 而载体在 B 时，一律当场报冲突并点名文件，绝不覆盖也绝不孤立。',
    '声明指向的文件不在磁盘上时，工程会被就地修好而不是整个编辑不动：'
      + '该 id 的载体在别处就把声明接过去（redeclared 行），实在接不上（同 id 两份载体 / 文件名'
      + '推不出 slug）就摘掉那条悬空声明并在 warnings 里说明怎么接回来（dropped dangling 行，'
      + 'entryScene 指着它时一并撤下）。这些修复只发生在「声明指向的文件本就不存在」这一档，'
      + '不会动任何有内容的文件。',
    '整体校验只拦本次编辑**新引入**的破损：装载时就已经存在的（继承环、同 id 双载体、'
      + '悬空引用、角色冲突……）一律随 warnings 报出而不阻断，因为拦住它等于把工程锁死在坏状态里。'
      + '工程原本健康时任何新破损照旧当场失败、零文件落盘。',
    'game.project.json 不能出现在自己的 scenes / prefabs / assets 声明里（它是工程拓扑的根）：'
      + '装载时就有的那一档会被就地摘掉并留一行 dropped self-declaration，'
      + '本次编辑写进去的当场失败、零文件落盘。',
    '一个稳定 id 只许有一个载体，这条在「编辑器创建或采纳清单」的那一刻强制。'
      + '编辑一份已经被声明的清单不扫工程目录（省一次全盘遍历），因此你事后用 project:edit 手写的'
      + '第二份同 id 文件在那条路径上不会被发现——它也不会被工程加载。要让它生效就把它变成'
      + '唯一载体（删掉或改名另一份），或直接改用它的 id。',
  ],
  schema: GameSceneEditSchema,
  permissions: ['fs:read', 'fs:write'],
  capabilities: GameManifestEditCapability,
  hideWhenUnavailable: GameToolHiddenWhenUnavailable,
  isAvailable: isGameSessionAvailable,
  unavailableReason: gameSessionUnavailableReason,
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
    '结果里的 firstFrame 是页面就绪那一刻的可见性：renderedEntities 是真的画出来的实体数。'
      + 'renderedEntities=0 而 entityCount>0 = **跑起来了但画面上只有调试叠加层**，'
      + '别据此报告成功——runtimeErrors 里会逐实体说明原因（通常是组件名没被认识）。',
  ],
  examples: [{}, { scene: 'scene:level-1', restart: true, timeoutMs: 60_000 }],
  notes: [
    'V0 始终等待可交互状态，不暴露无法形成闭环的 waitForReady=false 分支。',
    '宿主没有注入获批进程端口时默认拒绝。',
    'firstFrame 与 runtimeErrors 里的页面诊断是 best-effort 观测：读不到时字段缺席，'
      + '不会把一次成功的启动翻成失败。',
  ],
  schema: GameRunSchema,
  permissions: ['fs:read', 'process:exec', 'browser:control'],
  capabilities: GameRunCapability,
  hideWhenUnavailable: GameToolHiddenWhenUnavailable,
  isAvailable: isGameSessionAvailable,
  unavailableReason: gameSessionUnavailableReason,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    requireProject(context)
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
  hideWhenUnavailable: GameToolHiddenWhenUnavailable,
  isAvailable: isGameSessionAvailable,
  unavailableReason: gameSessionUnavailableReason,
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
    '不要在游戏未运行时调用；先 game:run。',
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
  hideWhenUnavailable: GameToolHiddenWhenUnavailable,
  isAvailable: isGameSessionAvailable,
  unavailableReason: gameSessionUnavailableReason,
  isConcurrencySafe: () => false,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    requireProject(context)
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
    'select=scene 除了 entityCount 还给 renderedEntities / invisibleEntities（两者之和 = entityCount）。'
      + '「实体都在、画面却是空的」只有这两个数看得出来——entityCount 与 fps 对它完全无感。',
  ],
  examples: [
    {},
    { select: 'entity', entityId: 'player', components: ['transform', 'body'] },
    { select: 'errors', limit: 20, offset: 0 },
  ],
  notes: [
    'V0 不增加独立 game:assert；查询保持单一真值，断言由调用方基于结构化结果完成。',
  ],
  schema: GameQueryStateSchema,
  permissions: ['browser:control'],
  capabilities: GameObserveCapability,
  hideWhenUnavailable: GameToolHiddenWhenUnavailable,
  isAvailable: isGameSessionAvailable,
  unavailableReason: gameSessionUnavailableReason,
  isConcurrencySafe: () => true,
  execute: async (input, context) => {
    context.abortSignal.throwIfAborted()
    requireProject(context)
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
  hideWhenUnavailable: GameToolHiddenWhenUnavailable,
  isAvailable: isGameSessionAvailable,
  unavailableReason: gameSessionUnavailableReason,
  isConcurrencySafe: () => false,
  execute: async ({ steps, repeat, settleFrames, captureAfter }, context) => {
    context.abortSignal.throwIfAborted()
    requireProject(context)
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

    if (isEmpty(validSteps)) return {
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
        `game:input 的显式等待总时长为 ${requestedWaitMs}ms，超过单次 10000ms 上限；请拆批并在批次间 query。`,
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
