import { copyFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../packages/velaros/', import.meta.url))
for (const group of readdirSync(`${root}act`, { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const file of readdirSync(`${root}act/${group.name}`)) {
    if (file === 'template.js' || file.endsWith('-template.js')) copyFileSync(`${root}act/${group.name}/${file}`, `${root}dist/act/${group.name}/${file}`)
  }
}
