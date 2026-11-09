#!/usr/bin/env node

import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { CodeSurfaces } from '../script/surfaces.mjs'

import { runGuardedCommand, safePackPackage } from './safe-package-pack.mjs'
import {
  distributionForVelarosPath,
  platformDistributions,
  sharedDeclarationSupport,
} from './platform-distributions.mjs'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')
const selector = process.argv[2]

if (!selector || process.argv.length !== 3) {
  throw new Error('Usage: bun run check:package-pack -- <package-directory>')
}

const directoryName = selector.replace(/^@velaros-ai\//u, '').replace(/^packages\//u, '')

if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(directoryName)) {
  throw new Error(`Invalid package directory selector: ${selector}`)
}

const distribution = Object.hasOwn(platformDistributions, directoryName) ? directoryName : undefined
const packageDirectory = path.join(
  repositoryRoot,
  'packages',
  distribution ? 'velaros' : directoryName
)
const manifest = JSON.parse(await readFile(path.join(packageDirectory, 'package.json'), 'utf8'))
if (distribution) manifest.name = platformDistributions[distribution].name
const destination = await mkdtemp(path.join(tmpdir(), 'velaros-package-pack-check-'))
const skillResources = path.join(repositoryRoot, 'packages/velaros/skills/resources')
const skillResourceFiles = (
  await Promise.all(
    (await readdir(skillResources, { recursive: true })).map(async (file) =>
      (await stat(path.join(skillResources, file))).isFile()
        ? `package/dist/skills/resources/${file.split(path.sep).join('/')}`
        : null
    )
  )
).filter(Boolean)
// 运行时要用的 vendor 产物必须进包；许可证文件不进包（只有仓根一份 LICENSE）。
const requiredPackageFiles = new Map([
  [
    'velaros',
    [
      ...new Set(
        CodeSurfaces.filter(
          (surface) =>
            surface.directory === 'velaros' &&
            surface.unit.startsWith('act/') &&
            distributionForVelarosPath(surface.unit) === 'velaros'
        ).flatMap((surface) =>
          [surface.templates].flat().map((file) => `package/dist/${surface.unit}/${file}`)
        )
      ),
    ],
  ],
  [
    'capabilities',
    [
      'package/office/vendor/pptxgenjs/pptxgen.es.js',
      ...new Set(
        CodeSurfaces.filter(
          (surface) =>
            surface.directory === 'velaros' &&
            surface.unit.startsWith('act/') &&
            distributionForVelarosPath(surface.unit) === 'capabilities'
        ).flatMap((surface) =>
          [surface.templates].flat().map((file) => `package/dist/${surface.unit}/${file}`)
        )
      ),
      ...skillResourceFiles,
      'package/dist/skills/contract/surface.js',
      'package/browser/vendor/devtools-performance-engine/devtoolsPerformanceEngine.mjs',
    ],
  ],
])

try {
  await safePackPackage({ destination, packageDirectory, distribution })
  const tarballs = (await readdir(destination)).filter((file) => file.endsWith('.tgz'))
  if (tarballs.length !== 1) {
    throw new Error(`${manifest.name ?? directoryName} produced ${tarballs.length} tarballs`)
  }
  const tarballPath = path.join(destination, tarballs[0])
  const { stdout } = await runGuardedCommand({
    args: ['-tzf', tarballPath],
    command: 'tar',
    cwd: repositoryRoot,
    operation: `List ${manifest.name ?? directoryName} package tarball`,
  })
  const entries = new Set(stdout.split('\n').filter(Boolean))
  if (distribution) {
    for (const entry of entries) {
      const relative = entry.replace(/^package\//u, '')
      if (relative.startsWith('dist/')) {
        if (sharedDeclarationSupport.includes(relative)) continue
        if (distributionForVelarosPath(relative) !== distribution)
          throw new Error(`${manifest.name} includes another distribution's source: ${entry}`)
      }
    }
  }
  for (const requiredFile of [
    'package/package.json',
    'package/README.md',
    ...(requiredPackageFiles.get(directoryName) ?? []),
  ]) {
    if (!entries.has(requiredFile)) {
      throw new Error(`${manifest.name ?? directoryName} tarball is missing ${requiredFile}`)
    }
  }

  const archive = await stat(tarballPath)
  console.info(`✓ ${manifest.name}@${manifest.version} packed safely (${archive.size} bytes)`)
} finally {
  await rm(destination, { force: true, recursive: true })
}
