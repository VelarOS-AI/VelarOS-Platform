#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 能力包的进程壳：把命令行交给 `@velaros-ai/document-renderer` 的那件能力，再写 stdout、设退出码。
 * 判参数、读请求、拼回执都在包里，这里不写逻辑。
 *
 * 两个环境变量正常由打包出来的启动脚本设好，这里只在能力包自带的 `canvas.node` 真在旁边时兜底：
 * 本仓开发时直接跑这个文件的话，指一个不存在的路径反而会让 `@napi-rs/canvas` 加载不起来。
 *
 * 这里刻意用动态 import：`@napi-rs/canvas` 在模块加载时就按 `NAPI_RS_NATIVE_LIBRARY_PATH` 找原生库，
 * 静态 import 会赶在这几行之前把它加载起来。
 */
async function main(): Promise<void> {
  const resourcesRoot = dirname(process.execPath)
  const bundledCanvas = join(resourcesRoot, 'canvas.node')
  if (existsSync(bundledCanvas)) {
    process.env.VELAROS_DOCUMENT_RENDERER_RESOURCES_ROOT ??= resourcesRoot
    process.env.NAPI_RS_NATIVE_LIBRARY_PATH ??= bundledCanvas
  }
  const { documentRenderer } =
    await import('../../../packages/document-renderer/src/exports/index')
  const result = await documentRenderer.runCli(process.argv.slice(2))
  process.stdout.write(result.text)
  process.exitCode = result.exitCode
}

if (import.meta.main) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
