/**
 * 宿主内置静态服务的**机械锁**。
 *
 * 这台服务是「工程只出清单也能跑起来」的兑现点，同时也是本仓第一次在游戏域里开一个监听端口。
 * 所以这份电池分两半：
 *  1. **它真的能把那三样东西送出去**（页面骨架 / 运行时脚本 / 已解析的 boot 负载），
 *     否则验收线还是断的；
 *  2. **它绝不是一个本地文件服务器**——非声明路径、路径穿越、非本机 Host、非 GET、
 *     表外扩展名逐条锁死。安全那半是硬要求，写成断言才叫落地。
 */
import { describe, expect, test } from 'bun:test'

import type {
  GameManifestDocument,
  GameManifestDocumentStore,
} from '../dist/core/index.js'
import {
  type GameBootPayload,
  GameBuiltinDevServer,
  type GameBuiltinHostFilePort,
  type GameManagedDevProcess,
} from '../dist/runtime/index.js'

class FixtureManifestStore implements GameManifestDocumentStore {
  private readonly documents = new Map<string, GameManifestDocument>()

  public constructor(entries: Record<string, unknown>) {
    for (const [path, value] of Object.entries(entries)) {
      this.documents.set(path, { path, text: JSON.stringify(value), revision: 'r1' })
    }
  }

  public async read(path: string): Promise<GameManifestDocument | null> {
    return this.documents.get(path) ?? null
  }

  public async listManifests(): Promise<readonly GameManifestDocument[]> {
    return [...this.documents.values()]
  }

  public async writeBatch(): Promise<void> {
    throw new Error('内置服务只读，不该写盘。')
  }
}

class FixtureFilePort implements GameBuiltinHostFilePort {
  public readonly reads: string[] = []

  public constructor(private readonly files: Record<string, string>) {}

  public async readFile(projectPath: string): Promise<Nullable<Uint8Array>> {
    this.reads.push(projectPath)
    const text = this.files[projectPath]
    return text === undefined ? null : new TextEncoder().encode(text)
  }
}

function fixtureManifests(): Record<string, unknown> {
  return {
    'game.project.json': {
      name: 'builtin-host-fixture',
      entryScene: 'scene:main',
      scenes: ['scenes/main.scene.json'],
      assets: 'assets/assets.json',
      layers: ['actors'],
      input: { actions: { jump: ['Space'] } },
    },
    'scenes/main.scene.json': {
      id: 'main',
      entities: [
        {
          id: 'hero',
          components: {
            transform: { position: { x: 40, y: 60 } },
            visual: { kind: 'shape', shape: 'rect', width: 32, height: 32, color: '#4ade80' },
            script: { module: 'scripts/hero.js' },
          },
        },
        {
          id: 'legacy',
          components: { script: { module: 'scripts/legacy.ts' } },
        },
      ],
    },
    'assets/assets.json': {
      assets: [{ id: 'tile', kind: 'texture', path: 'assets/tile.png' }],
    },
  }
}

async function withServer(
  run: (input: {
    readonly origin: string
    readonly files: FixtureFilePort
    readonly boot: () => Promise<GameBootPayload>
  }) => Promise<void>,
): Promise<void> {
  const files = new FixtureFilePort({
    'assets/tile.png': 'PNG-BYTES',
    'scripts/hero.js': 'export default () => ({})',
    'scripts/legacy.ts': 'export default (): unknown => ({})',
  })
  const server = new GameBuiltinDevServer({
    documents: new FixtureManifestStore(fixtureManifests()),
    files,
    pageScript: 'globalThis.__pageScriptLoaded = true',
  })
  let managed: GameManagedDevProcess | null = null
  try {
    managed = await server.start()
    const ready = await managed.waitUntilReady({ timeoutMs: 1_000 })
    expect(ready.outcome.kind).toBe('ready')
    const origin = new URL(ready.url).origin
    expect(new URL(ready.url).hostname).toBe('127.0.0.1')
    await run({
      origin,
      files,
      boot: async () => {
        const response = await fetch(`${origin}/__velaros/boot.json`)
        expect(response.status).toBe(200)
        return (await response.json()) as GameBootPayload
      },
    })
  } finally {
    await managed?.stop(false)
  }
}

describe('GameBuiltinDevServer', () => {
  test('serves the page skeleton, the runtime bundle and a resolved boot payload', async () => {
    await withServer(async ({ origin, boot }) => {
      const index = await fetch(`${origin}/`)
      expect(index.status).toBe(200)
      expect(index.headers.get('content-type')).toContain('text/html')
      const html = await index.text()
      expect(html).toContain('/__velaros/page.js')
      expect(html).toContain('builtin-host-fixture')

      const script = await fetch(`${origin}/__velaros/page.js`)
      expect(script.status).toBe(200)
      expect(script.headers.get('content-type')).toContain('javascript')
      expect(await script.text()).toBe('globalThis.__pageScriptLoaded = true')

      const payload = await boot()
      // 解析发生在宿主侧：页面拿到的是**已经继承/合并完**的一幕，浏览器里不再跑一遍。
      expect(payload.scene.id).toBe('main')
      expect(payload.scene.entities.map((entity) => entity.id)).toEqual(['hero', 'legacy'])
      expect(payload.project.name).toBe('builtin-host-fixture')
      expect(payload.assets.assets[0]?.id).toBe('tile')
    })
  })

  test('serves declared assets and declared browser-loadable scripts, and nothing else', async () => {
    await withServer(async ({ origin, boot }) => {
      await boot()

      const asset = await fetch(`${origin}/assets/tile.png`)
      expect(asset.status).toBe(200)
      expect(asset.headers.get('content-type')).toBe('image/png')
      expect(asset.headers.get('x-content-type-options')).toBe('nosniff')
      expect(await asset.text()).toBe('PNG-BYTES')

      const script = await fetch(`${origin}/scripts/hero.js`)
      expect(script.status).toBe(200)
      expect(script.headers.get('content-type')).toContain('javascript')

      // 磁盘上真实存在、但没有被任何清单声明 → 依然取不到。这条就是「不是文件服务器」。
      const undeclared = await fetch(`${origin}/scripts/legacy.ts`)
      expect(undeclared.status).toBe(404)
    })
  })

  test('reports non-servable script modules instead of pretending they loaded', async () => {
    await withServer(async ({ boot }) => {
      const payload = await boot()
      expect(payload.scripts.map((entry) => entry.module)).toEqual(['scripts/hero.js'])
      const issue = payload.scriptIssues[0]
      expect(issue?.module).toBe('scripts/legacy.ts')
      expect(issue?.reason).toContain('dev.server.command')
    })
  })

  test('refuses path traversal, unknown routes, foreign Host headers and writes', async () => {
    await withServer(async ({ origin, files, boot }) => {
      await boot()
      const before = files.reads.length

      // 路径穿越在结构上不可能：路由只查表，不 join 路径——所以这些请求连读盘都不会发生。
      for (const pathname of [
        '/../game.project.json',
        '/%2e%2e/game.project.json',
        '/assets/../../etc/passwd',
        '/game.project.json',
        '/scenes/main.scene.json',
        '/package.json',
      ]) {
        const response = await fetch(`${origin}${pathname}`)
        expect(response.status).toBe(404)
      }
      expect(files.reads.length).toBe(before)

      const rebind = await fetch(`${origin}/`, { headers: { host: 'evil.example.com' } })
      expect(rebind.status).toBe(403)

      const written = await fetch(`${origin}/assets/tile.png`, { method: 'POST' })
      expect(written.status).toBe(405)
    })
  })

  test('serves nothing at all before the first boot declares an allowlist', async () => {
    await withServer(async ({ origin, files }) => {
      const asset = await fetch(`${origin}/assets/tile.png`)
      expect(asset.status).toBe(404)
      expect(files.reads).toBeEmpty()
    })
  })

  test('stops listening on stop(), leaving no port behind', async () => {
    const server = new GameBuiltinDevServer({
      documents: new FixtureManifestStore(fixtureManifests()),
      files: new FixtureFilePort({}),
      pageScript: 'void 0',
    })
    const managed = await server.start()
    const { url } = await managed.waitUntilReady({ timeoutMs: 1_000 })
    expect((await fetch(url)).status).toBe(200)
    await managed.stop(false)
    await expect(fetch(url)).rejects.toThrow()
  })

  test('fails loudly when the host forgot to inject the runtime bundle', async () => {
    const server = new GameBuiltinDevServer({
      documents: new FixtureManifestStore(fixtureManifests()),
      files: new FixtureFilePort({}),
      pageScript: '',
    })
    await expect(server.start()).rejects.toThrow('dist/browser/page.js')
  })
})
