/**
 * 浏览器包**约定的常量表**：身份、目录约定、写进工具说明与 schema 的上限。整份随 `./core/contracts` 出包，
 * 宿主与渲染进程都读得到；改这里等于改对外契约。
 *
 * 这个文件**不 import 任何东西**、不用 Node 专属类型：它和可移植数据文件 `types/browser.ts` 一起构成
 * 渲染进程能加载的那一半。包内可调的数字（超时、缓冲、保留条数）不在这里，在 `utils/tuning.ts`。
 */

/**
 * 浏览器 mod 的身份。
 *
 * 单独成常量而不是留在工具文件里，是因为消费者分处两端：装配侧要它来注册随包 mod，
 * 而产品壳的**空间门控声明**（renderer 也会读的那份 descriptor）只需要这一个字符串。
 * 后者若从工具文件取，就会把浏览器工具集与整条 Node 侧运行时依赖拖进渲染层 bundle。
 */
export const BrowserModId = 'velaros.browser' as const

/** 浏览器空间的身份；空间配方与 mod 清单都按它对齐。 */
export const BrowserSpaceId = 'browser' as const

/**
 * 站点工作区里各类产物的目录名 —— **对外约定**：宿主的文件面板与 `browser:files` 按它找产物，
 * 改了等于改用户在磁盘上看到的目录结构。
 */
export const BrowserWorkspaceArtifactDirectoryMap = Object.freeze({
  /** 页面快照（HTML / 正文）。 */
  page: 'pages',
  /** recipe 骨架与它的修订。 */
  recipe: 'recipes',
  /** 结构化提取的结果（表格、列表、正文）。 */
  extract: 'extracts',
  /** 模型自己写的笔记。 */
  note: 'notes',
  /** recipe 的每次执行记录。 */
  run: 'runs',
  /** 下载与抓取到的文件。 */
  download: 'downloads',
})

/** 产物格式到文件扩展名的约定：落盘的文件名按它拼，宿主按扩展名认类型。 */
export const BrowserWorkspaceArtifactFormatExtensionMap = Object.freeze({
  /** 结构化数据。 */
  json: 'json',
  /** 纯文本。 */
  text: 'txt',
  /** Markdown 正文。 */
  markdown: 'md',
  /** 原始 HTML。 */
  html: 'html',
})

/** 工作区文件读写的公开上限：写进 `browser:files` 的说明与 schema，模型看到的就是这些数。 */
export const BrowserFileLimits = Object.freeze({
  /** 读一个文件不给 endLine、maxChars 时最多返回多少字符。 */
  readChars: 200_000,
  /** 列目录一次最多返回多少条。 */
  listItems: 1_000,
  /** 递归列目录最多往下走几层。 */
  listDepth: 16,
})

/** 站点用户脚本的公开上限：写进 `browser:user_scripts` 的说明与 schema。 */
export const BrowserUserScriptLimits = Object.freeze({
  /** 一个用户脚本的代码最多多少字节。 */
  codeBytes: 1_000_000,
  /** 一个用户脚本最多几条 match / excludeMatch 规则。 */
  matchRules: 64,
})

/** 抓取远程资源的公开上限：写进 `browser:fetch_resource` 的说明。 */
export const BrowserFetchLimits = Object.freeze({
  /** 单个文件最多下载多少字节（50 MB）。 */
  fileBytes: 52_428_800,
})

/** 浏览器包的失败原因码：外面按码判断，不按文案判断。 */
export const BrowserErrorCodes = Object.freeze({
  /** 界面没装浏览器合成 Provider，拿不到受控页面。 */
  compositionNotInstalled: 'BROWSER_COMPOSITION_NOT_INSTALLED',
})
