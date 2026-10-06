import { copyFileSync, cpSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../packages/velaros/', import.meta.url))
// Skill 文档与示例随构建结果分发，运行时按需读取同一份源文档。
cpSync(`${root}skills/resources`, `${root}dist/skills/resources`, { recursive: true })
for (const group of readdirSync(`${root}act`, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const file of readdirSync(`${root}act/${group.name}`)) {
    if (file === 'template.js' || file.endsWith('-template.js'))
      copyFileSync(`${root}act/${group.name}/${file}`, `${root}dist/act/${group.name}/${file}`)
  }
}
