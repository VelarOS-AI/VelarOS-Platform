import {
  readdirSync,
  rmSync,
} from 'node:fs'
import { resolve } from 'node:path'

const PackageRoot = resolve(import.meta.dirname, '../..')

for (const directory of ['dist', '.tmp']) {
  rmSync(resolve(PackageRoot, directory), {
    force: true,
    recursive: true,
  })
}

for (const entry of readdirSync(PackageRoot)) {
  if (/^velaros-project-.*\.tgz$/.test(entry)) {
    rmSync(resolve(PackageRoot, entry), { force: true })
  }
}
