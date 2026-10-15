import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 独立消费项目使用 tsd 各版本都支持的位置参数，避免自定义文件被忽略或错误拼接。
export async function runTsdConsumer(source) {
  const directory = await mkdtemp(join(tmpdir(), 'evaluation-type-consumer-'))
  try {
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({ name: 'evaluation-type-consumer', private: true, types: 'index.d.ts' })
    )
    await writeFile(join(directory, 'index.d.ts'), 'export {};\n')
    await writeFile(join(directory, 'index.test-d.ts'), source)
    return spawnSync(process.execPath, [resolve('node_modules/tsd/dist/cli.js'), directory], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 30000,
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
