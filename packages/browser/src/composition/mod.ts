import type { ToolCategoryDefinition } from '@velaros-ai/agent/protocol'

import { BrowserModId, BrowserSpaceId } from '../core/BrowserModIdentity'
import { browserTools } from '../tools/Collection'

// @arch-guard:suspend code-style/require-chinese-comments 理由：本块为中文说明，技术标识符（availableInSpaces/localhost/composeAgentModSpaces 等）密度触发启发式误报。
/**
 * 浏览器工具**客居**的绑根空间（project 空间由 `@velaros-ai/project` 贡献）。
 *
 * 为什么浏览器能力要伸进项目空间：前端开发最高频的一句话是「起服务，打开 localhost:3000
 * 看看渲染对不对」。此前项目空间唯一的取网口是 `web:read`——只回正文文本，不能截图、
 * 不能点击，于是「改一行 CSS 看效果」在产品里跨不过去，用户只能另开一个没有项目根的
 * 浏览器会话（看不到代码、也改不了代码）。跨空间重复能力会让这条常见工作流付出额外切换代价。
 *
 * 只写进 `availableInSpaces`、**不写** `residentInSpaces`：客居 = 可用不常驻。项目空间每轮
 * 的 schema 仍是项目那套，浏览器工具留在 loadable 由模型按名换入（`browser:enter_site`
 * 没有 `isAvailable` 门，可自举）。写进常驻集就等于给每个项目会话每轮塞六个浏览器工具。
 *
 * 装配前提：本 mod 与 project mod 同装（Desktop 出厂即如此）。`composeAgentModSpaces`
 * 对不存在的空间**当场抛错**——那是刻意的，引用一个没人贡献的空间属于无效装配。
 * 继承 project 配方的其他空间也会自动继承本条，不需要再点名一次。
 */
const BrowserGuestSpaceIds = ['project'] as const

/**
 * 浏览器空间的常驻工具（每轮都带真实 schema 进请求）。
 *
 * 只钉「看 — 动 — 等 — 取」这条主回路：不看页面就无从动作，动作后要等事件、要取内容。
 * 其余三十多个工具（网络/控制台/媒体/录屏/下载/用户脚本/性能…）都是排障或特化场景，
 * 留在 loadable，由模型从 `tooling:map` 按名换入——常驻不是「装得下就都装」。
 */
const BrowserResidentToolNames = new Set<string>([
  'browser:inspect_page',
  'browser:act',
  'browser:extract',
  'browser:capture_screenshot',
  'browser:get_page_state',
  'browser:wait_for_pending_event',
])

/**
 * 浏览器职责分类：一个分类 = 一个使用场景（4–8 个工具），不是一个实现文件。
 *
 * 41 个工具全压在一个 `browser` 分类里时，「按类换入」的粒度等于「全都换进来」——
 * 模型要一个 `browser:handle_dialog` 就得把网络、录屏、用户脚本一起拖进目录。
 * 拆成七页之后跨场景需求走**一次 pageIn 传多页**（协议本就收数组），不需要新机制。
 *
 * 分类归属是**唯一事实来源**：每个工具恰好落一页，七页并集 = `browserTools` 全集。
 */
const BrowserToolNamesByCategory = {
  /** 跑通一次自动化的最小回路：看 — 动 — 取 — 等。恰好等于常驻集。 */
  'browser-core': [
    'browser:inspect_page',
    'browser:act',
    'browser:extract',
    'browser:capture_screenshot',
    'browser:get_page_state',
    'browser:wait_for_pending_event',
  ],
  /** 站点工作区与页面（tab）的进出、显示与切换。 */
  'browser-session': [
    'browser:enter_site',
    'browser:leave_site',
    'browser:site_context',
    'browser:space_manifest',
    'browser:show_page',
    'browser:switch_page_target',
    'browser:list_page_targets',
  ],
  /** 页面结构、元素与本地状态的细粒度观察。 */
  'browser-observe': [
    'browser:query_elements',
    'browser:get_element_bounds',
    'browser:observe_actions',
    'browser:get_page_diagnostics',
    'browser:read_page_data',
    'browser:read_page_storage',
  ],
  /** 网络、控制台与性能信号——排障时才需要。 */
  'browser-network': [
    'browser:list_network_events',
    'browser:get_network_request',
    'browser:get_network_response_body',
    'browser:list_console_events',
    'browser:list_page_errors',
    'browser:performance',
  ],
  /** 弹窗、下载、权限等待用户裁决的页面事件。 */
  'browser-events': [
    'browser:handle_dialog',
    'browser:handle_download',
    'browser:handle_permission',
    'browser:list_pending_events',
  ],
  /** 文件进出：站点产物、导出、上传与资源抓取。 */
  'browser-files': [
    'browser:files',
    'browser:export_page',
    'browser:upload_file',
    'browser:fetch_resource',
    'browser:list_page_resources',
    'browser:list_media_sources',
  ],
  /** 任意脚本、配方、录屏与区域截图等特化能力。 */
  'browser-advanced': [
    'browser:evaluate_script',
    'browser:user_scripts',
    'browser:recipe',
    'browser:screencast',
    'browser:capture_region',
  ],
} as const satisfies Record<string, readonly string[]>

type BrowserToolCategoryId = keyof typeof BrowserToolNamesByCategory

const BrowserToolCategoryDefinitions = Object.freeze<
  Record<BrowserToolCategoryId, ToolCategoryDefinition>
>({
  'browser-core': {
    id: 'browser-core',
    label: 'Browser core',
    description: '浏览器主回路：读页面、执行动作、取内容、等事件。',
    toolOs: { domain: 'browser', defaultState: 'resident' },
  },
  'browser-session': {
    id: 'browser-session',
    label: 'Browser session',
    description: '站点工作区与页面标签的进出、显隐和切换。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-observe': {
    id: 'browser-observe',
    label: 'Browser inspection',
    description: '元素查询、坐标、动作回放与页面本地状态读取。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-network': {
    id: 'browser-network',
    label: 'Browser network',
    description: '网络请求、控制台、页面错误与性能采集。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-events': {
    id: 'browser-events',
    label: 'Browser events',
    description: '弹窗、下载与权限等待处理的页面事件。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-files': {
    id: 'browser-files',
    label: 'Browser files',
    description: '站点产物、页面导出、文件上传与资源抓取。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
  'browser-advanced': {
    id: 'browser-advanced',
    label: 'Browser advanced',
    description: '任意脚本执行、用户脚本、配方、录屏与区域截图。',
    toolOs: { domain: 'browser', defaultState: 'loadable' },
  },
})

const BrowserToolCategoryIds = Object.keys(
  BrowserToolCategoryDefinitions
) as BrowserToolCategoryId[]

/**
 * 工具名 → 分类的反向索引。
 *
 * 建表时对着 `browserTools` 全集校验：漏登记一个工具就当场抛错，而不是让它静默落进
 * 一个没人认识的分类、于是所有按类别把门的判定对它失灵。
 */
const BrowserToolCategoryByName = new Map<string, BrowserToolCategoryId>()
for (const categoryId of BrowserToolCategoryIds) {
  for (const toolName of BrowserToolNamesByCategory[categoryId]) {
    BrowserToolCategoryByName.set(toolName, categoryId)
  }
}

function resolveBrowserToolCategoryId(toolName: string): BrowserToolCategoryId {
  const categoryId = BrowserToolCategoryByName.get(toolName)
  if (!categoryId)
    throw new Error(
      `browser mod: 工具 ${toolName} 没有登记分类，请在 BrowserToolNamesByCategory 里补上。`
    )

  return categoryId
}

const BrowserAgentModManifest = Object.freeze({
  id: BrowserModId,
  version: '0.2.6',
  publisher: 'VelarOS',
  displayName: 'VelarOS Browser',
  description: '浏览器空间与浏览器职责工具。',
  manifestSchemaVersion: 1,
  engines: { velaros: '*', agent: '*' },
  trust: 'bundled-official',
  requiredAxes: ['tools', 'toolCategories', 'spaces'],
  contributes: {
    toolCategories: BrowserToolCategoryIds.map((categoryId, index) => ({
      id: categoryId,
      label: BrowserToolCategoryDefinitions[categoryId].label,
      description: BrowserToolCategoryDefinitions[categoryId].description,
      order: 20 + index,
    })),
    tools: Object.keys(browserTools).map((name) => ({
      name,
      categoryId: resolveBrowserToolCategoryId(name),
      availableInSpaces: [BrowserSpaceId, ...BrowserGuestSpaceIds],
      ...(BrowserResidentToolNames.has(name) ? { residentInSpaces: [BrowserSpaceId] } : {}),
    })),
    /*
     * 只声明**真被消费**的那几格：身份策略、绑定能力、职责类别。
     *
     * 空间的标题 / 提示 / 图标 / 顺序不在这里——权威是产品壳的枚举表（Desktop 的
     * `DesktopCapabilityScopeDescriptors`，文案还要走 i18n 键）。此处曾另有一份
     * `descriptor` + `iconId`，与壳里那份逐字不同（'Browser' vs「浏览器站点」）且零消费者：
     * 改 manifest 无效、改壳才生效——「空间叫什么」于是被两处各推一遍。删掉是承认现状。
     */
    spaces: [{
      id: BrowserSpaceId,
      identityStrategy: 'origin',
      boundCapabilityIds: [BrowserModId],
      toolCategoryIds: BrowserToolCategoryIds,
    }],
  },
})

interface BrowserBundledModDefinition {
  readonly id: typeof BrowserModId
  readonly specifier: string
  readonly defaultEnabled: true
  readonly manifest: typeof BrowserAgentModManifest
  readonly bindings: {
    readonly tools: typeof browserTools
    readonly toolCategories: Readonly<Record<BrowserToolCategoryId, ToolCategoryDefinition>>
  }
}

function createBrowserBundledModDefinition(): BrowserBundledModDefinition {
  return Object.freeze({
    id: BrowserModId,
    specifier: `bundled:${BrowserModId}`,
    defaultEnabled: true,
    manifest: BrowserAgentModManifest,
    bindings: Object.freeze({
      tools: browserTools,
      toolCategories: BrowserToolCategoryDefinitions,
    }),
  })
}

export {
  BrowserModId,
  BrowserResidentToolNames,
  BrowserSpaceId,
  BrowserToolCategoryDefinitions,
  BrowserToolCategoryIds,
  BrowserToolNamesByCategory,
  createBrowserBundledModDefinition,
}
export type { BrowserBundledModDefinition, BrowserToolCategoryId }
