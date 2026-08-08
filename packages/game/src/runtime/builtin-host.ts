/** 宿主内置的游戏静态服务：判决、安全边界与 eject 接缝都写在 {@link GameBuiltinDevServer} 上。 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'

import { isEmpty, isNotNull, isNull, isPresent, isString } from '@velaros-ai/core'
import { TimerScope } from '@velaros-ai/core/utils/TimerScope'

import {
  type GameAssetsManifest,
  type GameManifestDocumentStore,
  GameManifestResolver,
  type GamePrefabManifest,
  GameProjectFileName,
  type GameProjectManifest,
  gameReferenceId,
  type GameResolvedScene,
  type GameSceneManifest,
  parseGameAssetsManifestText,
  parseGamePrefabManifestText,
  parseGameProjectManifestText,
  parseGameSceneManifestText,
} from '../core/index.js'

import {
  type GameBootPayload,
  GameBuiltinHostBootRoute as BootRoute,
  GameBuiltinHostFaviconRoute as FaviconRoute,
  GameBuiltinHostIndexRoute as IndexRoute,
  GameBuiltinHostPageScriptRoute as PageScriptRoute,
  GameBuiltinHostSceneQueryKey as SceneQueryKey,
} from './builtin-host-contract.js'
import type { GameDevServerReadyResult, GameManagedDevProcess } from './dev-server.js'

/** 单个资产的回送上限；越界当场失败，绝不截半张图交给渲染器。 */
const MaxServedFileBytes = 64 * 1024 * 1024

/** 关服务等连接排空的上限；见 {@link GameBuiltinDevServer.stop}。 */
const BuiltinDevServerCloseTimeoutMs = 5_000

/**
 * 把请求路径解回清单里的原始写法（见 {@link GameBuiltinDevServer.serveDeclaredFile} 的判决）。
 * 畸形 `%` 序列 `decodeURIComponent` 会抛——按原样返回，让它落到 404 而不是把整个请求打崩。
 */
function decodeRequestPath(pathname: string): string {
  try {
    return decodeURIComponent(pathname)
  } catch {
    // arch-guard:silent-catch-ok 不是吞错：畸形 `%` 序列本来就不是合法请求路径，按原样回去
    // 就会在 `servable` 查表时落到 404 并带上正文说明——那条路径本身就是应答，没有第二个接收者。
    return pathname
  }
}

/** 可回送的静态资产类型闭集。表外扩展名一律拒绝，服务不做内容嗅探。 */
const ServableMediaTypes: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json; charset=utf-8',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.wav': 'audio/wav',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
}
/**
 * 可回送的玩法脚本扩展名。
 *
 * **刻意不含 `.ts`**：内置服务不转译（宿主里没有编译器，装一个就把「零安装」这条产品判据
 * 还回去了）。声明了 `.ts` 脚本的工程走 {@link GameBootPayload.scriptIssues} 如实说清，
 * 出路是把玩法写成浏览器可直接 import 的 ESM，或者声明自己的 `dev.server.command`。
 */
const ServableScriptExtensions = new Set(['.js', '.mjs'])
const ScriptMediaType = 'text/javascript; charset=utf-8'

export interface GameBuiltinHostFilePort {
  /**
   * 读一条**工程相对**路径的原始字节；文件不存在回 null。
   *
   * 越根、符号链接、非普通文件由宿主当场抛——本服务只负责「这条路径被清单声明过吗」，
   * 文件系统的边界永远归宿主，两边都收窄一次才是纵深。
   */
  readonly readFile: (projectPath: string) => Promise<Nullable<Uint8Array>>
}

export interface GameBuiltinDevServerOptions {
  readonly documents: GameManifestDocumentStore
  readonly files: GameBuiltinHostFilePort
  /**
   * 内置运行时页面脚本（`@velaros-ai/game` 构建产物 `dist/browser/page.js` 的全文）。
   *
   * 由宿主注入而不是包自己读盘：Desktop 把本包整个打进 `out/main`，包内的 `import.meta.url`
   * 在那份产物里指向 bundle 自己，任何「相对自己的 dist 找一个文件」的写法都会在打包版失灵。
   * 注入之后，「这段字节怎么随宿主走」是宿主的打包问题，本服务只管把它交出去。
   */
  readonly pageScript: string
}

export class GameBuiltinHostError extends Error {
  public constructor(message: string) {
    super(message)
    this.name = 'GameBuiltinHostError'
  }
}

function extensionOf(path: string): string {
  const lastDot = path.lastIndexOf('.')
  const lastSlash = path.lastIndexOf('/')
  return lastDot > lastSlash ? path.slice(lastDot).toLowerCase() : ''
}

/**
 * 页面骨架 —— **eject 接缝之一**：将来 `game:eject` 把这段原样落成工程里的 `index.html`。
 *
 * 刻意极简：一个容器 + 一条 module script。CSP 只放行同源，`object-src` / `base-uri` 关死；
 * 图片与音频额外放行 `data:` / `blob:`（Phaser 的纹理生成与音频解码要用）。
 */
function renderIndexHtml(title: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'">
<title>${escapeHtml(title)}</title>
<style>
  html,body{margin:0;height:100%;background:#0b0d12;overflow:hidden}
  #velaros-game-root{width:100%;height:100%;display:flex;align-items:center;justify-content:center}
  #velaros-game-root canvas{display:block;max-width:100%;max-height:100%}
</style>
</head>
<body><div id="velaros-game-root"></div><script type="module" src="${PageScriptRoute}"></script></body>
</html>
`
}

function escapeHtml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/**
 * 宿主内置的游戏静态服务 —— **「工程只出清单也能跑起来」的兑现点**。
 *
 * ## 判决（2026-08-01，产品负责人拍板）
 * `dev.server.command` 的缺省曾是一条包管理器命令，于是「空目录 → 建工程 → 起画面」这条验收线
 * 要求工程根自带 `package.json`、一份真实前端 dev server，外加一个引入本包运行时的入口模块。
 * 而本包发在 GH Packages（受限访问）、还依赖 phaser——模型自己补不出来。三条事实合起来 =
 * 这条线**结构上**走不通。
 *
 * 现在缺省换成本服务：**工程只出清单，连 `package.json` 都不要**。三条理由（已定，不再讨论）：
 *  1. 产品定调「极简 / 全委托 AI」，让 AI 画个绿方块之前先等一分钟装依赖，与它直接冲突；
 *  2. 铁律「玩法代码 + 声明式场景清单须渲染器无关」——清单是纯数据，工程里不该有
 *     `package.json` 这种宿主耦合物；
 *  3. 零安装 = 零网络 = 空目录到出画面是秒级，这才配得上「同一条消息里建完就跑」。
 *
 * **既有路径原样保留**：工程自己声明了 `dev.server.command` 就走它自己那条路。本服务是**缺省**，
 * 不是唯一。
 *
 * ## 承认的代价与逃生口
 * 「工程能脱离 VelarOS 独立跑」这条性质在第一阶段消失。留 **eject 接缝**保住它：页面骨架
 * （{@link renderIndexHtml}）与运行时投递（{@link GameBuiltinDevServerOptions.pageScript}）
 * 是两个显式的注入点，将来的 eject 工具只需把这两样连同一份 `package.json` 落到工程里，
 * 再给工程写上 `dev.server.command`——**运行门那一侧一个字都不用改**（声明了命令就走命令）。
 *
 * ## 安全（硬要求，不是「尽量」）
 *  - **绑 loopback + 临时端口**：`listen(0, '127.0.0.1')`，端口由内核分配，不占用清单端口。
 *  - **路由是闭集**：首页、运行时脚本、boot 负载，加上**上一次 boot 声明过的那些文件**。
 *    其余一律 404——它不是一个能读任意文件的本地文件服务器。
 *  - **文件不是拼路径拼出来的**：请求路径必须与 {@link GameBuiltinDevServer.servable} 里的键
 *    逐字相等，那张表由清单声明派生。路径穿越在结构上不可能（不做 join，只做查表）；
 *    根内确认与符号链接拒绝仍由宿主的 {@link GameBuiltinHostFilePort} 负责。
 *  - **Host 头必须是本机**：挡 DNS rebinding（外部页面把某域名解析到 127.0.0.1 再来读）。
 *  - **只认读方法**，且只回闭集内的内容类型。
 *
 * ## 生命周期
 * 挂 {@link GameDevServerController}：它拿到的是一份 {@link GameManagedDevProcess}，
 * 与「工程自带 dev server」那条路**同一个接口、同一套起停**（`game:stop`、会话删除、窗口关闭、
 * mod 停用、能力重建全都已经走 `runtime.stop()`）。
 *
 * **不会活过应用退出**，而且是结构上不会：它是本进程里的一个 `Server`，`unref()` 之后连事件
 * 循环都不占——不像 spawn 出去的子进程那样需要一条「终止命令」，也就没有「终止命令抛错被吞掉
 * 于是 dev server 活过应用退出」那个洞（那正是上一批在 `disposeSession` 四条路径上踩过的）。
 */
export class GameBuiltinDevServer {
  private server: Nullable<Server> = null
  private port = 0
  /**
   * 上一次 boot 声明过的可回送文件：URL 路径 → 工程相对路径。
   *
   * 文件路由**只认这张表**，而这张表只在 boot 时按清单重算。页面必然先 boot 再取资产，
   * 所以正常路径永远命中；没 boot 过就一个文件都不给——这正是「不许变成本地文件服务器」
   * 想要的那种默认。
   */
  private servable: ReadonlyMap<string, string> = new Map()

  public constructor(private readonly options: GameBuiltinDevServerOptions) {}

  public async start(): Promise<GameManagedDevProcess> {
    if (isEmpty(this.options.pageScript)) {
      throw new GameBuiltinHostError(
        '内置游戏运行时脚本缺失：宿主没有注入 @velaros-ai/game 的浏览器产物（dist/browser/page.js）。这是一次构建缺陷，不是工程的问题。',
      )
    }
    await this.stop()
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    this.server = server
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        if (isNull(address) || isString(address)) {
          reject(new GameBuiltinHostError('内置游戏静态服务没有拿到 TCP 端口。'))
          return
        }
        resolve(address.port)
      })
    })
    // 不占事件循环：应用退出时它随进程消失，不需要任何终止命令，也就不可能活过应用退出。
    server.unref()
    this.port = port
    return new GameBuiltinManagedProcess(this, `http://127.0.0.1:${port}/`, port)
  }

  /**
   * 停服务 —— **有上限**。
   *
   * `server.close()` 的回调要等所有连接都消失才触发。`closeAllConnections()` 之后正常情形
   * 立刻就绪，但只要有一条连接卡在内核态没被回收，这个 await 就永不返回；而
   * `start()` 的第一句就是 `await this.stop()`，于是「重启游戏」会在这里静静挂死
   * （AGENT-12 的同族形状：等外部资源的 await 没有上限）。
   *
   * 超时后**不再等**：句柄已经从字段上摘掉、监听套接字已经 close，残留连接由进程退出兜底。
   * 停服务是清理，宁可留一条将死的连接，也不许把「重启」变成永久挂起。
   */
  public async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.servable = new Map()
    this.port = 0
    if (!server) return
    server.closeAllConnections()
    const timers = new TimerScope({ name: 'GameBuiltinDevServer.stop' })
    try {
      await timers.withTimeout(
        BuiltinDevServerCloseTimeoutMs,
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve())
          }),
        {
          label: 'builtin-dev-server-close',
          timeoutMessage: `内置游戏静态服务关闭超过 ${BuiltinDevServerCloseTimeoutMs}ms。`,
        },
      )
    } catch {
      // arch-guard:silent-catch-ok 不是吞错：服务句柄已经摘掉、监听已 close，调用方要的
      // 「这个端口不再对外服务」已经成立。继续等只会把清理变成挂起，那正是本文件要根治的病。
    } finally {
      timers.dispose()
    }
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      await this.route(request, response)
    } catch (error) {
      // arch-guard:silent-catch-ok 不是吞错：原文经 500 正文回到页面，再经 `game.runtime-errors`
      // 到模型手里。这里没有更上层的接收者——抛出去只会变成一次连接重置。
      this.send(response, 500, 'text/plain; charset=utf-8', Buffer.from(describeError(error)))
    }
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      this.send(response, 405, 'text/plain; charset=utf-8', Buffer.from('只接受 GET / HEAD。'))
      return
    }
    if (!this.isLoopbackHost(request.headers.host)) {
      // DNS rebinding：外部页面把自己的域名解析到 127.0.0.1，再拿浏览器来读这个端口。
      this.send(response, 403, 'text/plain; charset=utf-8', Buffer.from('只接受本机 Host。'))
      return
    }
    const url = new URL(request.url ?? IndexRoute, `http://127.0.0.1:${this.port}`)
    if (url.pathname === IndexRoute) {
      this.send(
        response,
        200,
        'text/html; charset=utf-8',
        Buffer.from(renderIndexHtml(await this.readProjectName()), 'utf8'),
      )
      return
    }
    if (url.pathname === PageScriptRoute) {
      this.send(
        response,
        200,
        ScriptMediaType,
        Buffer.from(this.options.pageScript, 'utf8'),
      )
      return
    }
    if (url.pathname === BootRoute) {
      const payload = await this.buildBootPayload(url.searchParams.get(SceneQueryKey))
      this.send(
        response,
        200,
        'application/json; charset=utf-8',
        Buffer.from(JSON.stringify(payload), 'utf8'),
      )
      return
    }
    if (url.pathname === FaviconRoute) {
      // **明确谢绝，而不是 404**。浏览器会自己去要它，404 会在控制台留一条错误——而控制台
      // 错误正是 `game.runtime-errors` 的采集面：不答这一下，每一局游戏的每一轮上下文里都会
      // 多一条我们自己造的假报错。204 不是「服务一个文件」，是「明说这里没有」。
      response.writeHead(204, { 'cache-control': 'no-store' })
      response.end()
      return
    }
    await this.serveDeclaredFile(url.pathname, response)
  }

  /**
   * 请求路径是**百分号编码**的（`new URL(...).pathname` 的形态），而 {@link servable} 的键来自
   * 清单里的**原始**路径。含中文、空格一类字符的资产名两边逐字不等 —— 一律 404，而且 404 正文
   * 还谎称「不在本工程的声明里」（它明明声明了）。中文资产名在本产品里几乎必然出现。
   *
   * **解码而不是把键编码**：编码有多种合法写法（空格可以是 `%20` 也可以是 `+`，非 ASCII 有
   * 大小写十六进制之分），拿编码当键等于让「同一个文件」有多把钥匙。解码成唯一形态后，
   * 逐字相等这条安全判据原样成立 —— 依然不拼路径，依然只认表里的键。
   *
   * 解不开的（畸形 `%` 序列）按原样比，落到 404 —— 那本来就不该是一个合法请求。
   */
  private async serveDeclaredFile(
    pathname: string,
    response: ServerResponse,
  ): Promise<void> {
    const projectPath = this.servable.get(decodeRequestPath(pathname))
    if (!isPresent(projectPath)) {
      this.send(
        response,
        404,
        'text/plain; charset=utf-8',
        Buffer.from(
          `${pathname} 不在本工程的声明里。内置服务只回送清单声明过的资产与玩法脚本。`,
        ),
      )
      return
    }
    const extension = extensionOf(projectPath)
    const mediaType = ServableScriptExtensions.has(extension)
      ? ScriptMediaType
      : ServableMediaTypes[extension]
    if (!isPresent(mediaType)) {
      this.send(
        response,
        415,
        'text/plain; charset=utf-8',
        Buffer.from(`内置服务不回送 ${extension || '无扩展名'} 文件：${projectPath}。`),
      )
      return
    }
    const bytes = await this.options.files.readFile(projectPath)
    if (!isPresent(bytes)) {
      this.send(
        response,
        404,
        'text/plain; charset=utf-8',
        Buffer.from(`清单声明了 ${projectPath}，但工程根里没有这个文件。`),
      )
      return
    }
    if (bytes.byteLength > MaxServedFileBytes) {
      this.send(
        response,
        413,
        'text/plain; charset=utf-8',
        Buffer.from(`${projectPath} 超过 ${MaxServedFileBytes} bytes 上限。`),
      )
      return
    }
    this.send(response, 200, mediaType, Buffer.from(bytes))
  }

  private send(
    response: ServerResponse,
    status: number,
    mediaType: string,
    body: Buffer,
  ): void {
    response.writeHead(status, {
      'content-type': mediaType,
      'content-length': String(body.byteLength),
      // 清单随时会被 game:scene_edit 改；缓存住等于让「改完刷新」变成偶尔生效。
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(body)
  }

  private isLoopbackHost(host: LooseOptional<string>): boolean {
    if (!isPresent(host)) return false
    const expected = `:${this.port}`
    if (!host.endsWith(expected)) return false
    const name = host.slice(0, -expected.length)
    return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
  }

  private async readProjectName(): Promise<string> {
    try {
      const { project } = await this.readSourceSet()
      return project.name
    } catch {
      // arch-guard:silent-catch-ok 标题只是标题：工程读不出来时页面照常开，真实原因走 boot.json。
      return 'VelarOS Game'
    }
  }

  /**
   * 每次 boot 都重新读盘 —— **这就是留给热更的接缝**。
   *
   * 本批不做 HMR（不在验收线上），但形态上没有把路堵死：页面重载就是一次新的 boot，
   * 于是 `game:scene_edit` 改完清单、舞台按「重新加载页面」，画面就是新的。将来要真热更，
   * 只需在本服务上加一条 SSE 通道播「清单变了」，页面收到后重取 boot.json——
   * 负载形状与解析责任都不用动。
   */
  private async readSourceSet(): Promise<{
    readonly project: GameProjectManifest
    readonly scenes: readonly GameSceneManifest[]
    readonly prefabs: readonly GamePrefabManifest[]
    readonly assets: GameAssetsManifest
  }> {
    const projectDocument = await this.options.documents.read(GameProjectFileName)
    if (!projectDocument) {
      throw new GameBuiltinHostError(`工程根里没有 ${GameProjectFileName}。`)
    }
    const project = parseGameProjectManifestText(projectDocument.text, projectDocument.path).value

    const scenes: GameSceneManifest[] = []
    for (const path of project.scenes) {
      const document = await this.options.documents.read(path)
      if (!document) throw new GameBuiltinHostError(`工程声明的场景清单 ${path} 不存在。`)
      scenes.push(parseGameSceneManifestText(document.text, path).value)
    }
    const prefabs: GamePrefabManifest[] = []
    for (const path of project.prefabs) {
      const document = await this.options.documents.read(path)
      if (!document) throw new GameBuiltinHostError(`工程声明的 prefab 清单 ${path} 不存在。`)
      prefabs.push(parseGamePrefabManifestText(document.text, path).value)
    }
    const assetsDocument = await this.options.documents.read(project.assets)
    const assets: GameAssetsManifest = assetsDocument
      ? parseGameAssetsManifestText(assetsDocument.text, project.assets).value
      : { assets: [] }
    return { project, scenes, prefabs, assets }
  }

  private async buildBootPayload(requestedScene: Nullable<string>): Promise<GameBootPayload> {
    const source = await this.readSourceSet()
    const resolver = new GameManifestResolver(source)
    resolver.validate()
    const requested = requestedScene?.trim() ?? ''
    // 场景引用与裸 id 都接受（`scene:main` 与 `main` 是同一幕）——`GameRuntimePageHost.open`
    // 拼进 URL 的就是运行门解析后的裸 id，宽一格不会有歧义。
    const sceneId = isEmpty(requested)
      ? null
      : requested.includes(':')
        ? gameReferenceId(requested as `scene:${string}`)
        : requested
    const scene = isNotNull(sceneId) ? resolver.resolveScene(sceneId) : resolver.resolveEntryScene()
    if (!scene) {
      throw new GameBuiltinHostError(
        '工程没有 entryScene，本次也没有指定要开的场景；请先在 game.project.json 声明入口场景。',
      )
    }

    const servable = new Map<string, string>()
    for (const asset of source.assets.assets) servable.set(`/${asset.path}`, asset.path)

    const scripts: Array<{ module: string; url: string }> = []
    const scriptIssues: Array<{ module: string; reason: string }> = []
    for (const module of collectSceneScriptModules(scene)) {
      const extension = extensionOf(module)
      if (!ServableScriptExtensions.has(extension)) {
        scriptIssues.push({
          module,
          reason: `内置运行时服务只直送浏览器可 import 的 ESM（${[...ServableScriptExtensions].join(' / ')}），不转译 ${extension || '无扩展名'} 源码。把玩法写成 .js/.mjs，或在 game.project.json 里声明 dev.server.command 走工程自己的构建。`,
        })
        continue
      }
      const url = `/${module}`
      servable.set(url, module)
      scripts.push({ module, url })
    }
    this.servable = servable
    return { project: source.project, scene, assets: source.assets, scripts, scriptIssues }
  }
}

/** 一幕里真正引用到的玩法脚本模块（去重、保持声明顺序）。 */
function collectSceneScriptModules(scene: GameResolvedScene): readonly string[] {
  const modules: string[] = []
  for (const entity of scene.entities) {
    const module = entity.components.script?.module
    if (!isPresent(module) || modules.includes(module)) continue
    modules.push(module)
  }
  return modules
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把内置服务包装成一份 {@link GameManagedDevProcess}。
 *
 * 这一层存在的全部理由是**让运行门只有一条**：`GameDevServerController` 不需要知道这次是子进程
 * 还是内置服务，起停、就绪、终态判定全走同一个接口。两条平行的运行路径正是上一批反复吃亏的形状。
 */
class GameBuiltinManagedProcess implements GameManagedDevProcess {
  public constructor(
    private readonly server: GameBuiltinDevServer,
    private readonly url: string,
    private readonly port: number,
  ) {}

  public async waitUntilReady(): Promise<GameDevServerReadyResult> {
    // 已经 listen 成功了才走到这里：没有日志可等，也没有「可能还在编译」这一档。
    return {
      url: this.url,
      port: this.port,
      readyMs: 0,
      outcome: { kind: 'ready' },
      compileErrors: [],
      runtimeErrors: [],
      startupLogTail: `内置游戏静态服务已就绪：${this.url}（宿主内进程，未启动任何子进程）。`,
    }
  }

  public async stop(): Promise<{ readonly exitCode?: number }> {
    await this.server.stop()
    return {}
  }
}
