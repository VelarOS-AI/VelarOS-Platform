import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, parse, resolve } from 'node:path'

const LicenseFileName = /^(?:licen[sc]e|copying|notice)(?:[._-].*)?$/iu

async function readJsonFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'))
}

function packageRootForBundledInput(repositoryRoot, inputPath) {
  let current = dirname(resolve(repositoryRoot, inputPath))
  const filesystemRoot = parse(current).root
  while (current !== filesystemRoot) {
    if (basename(dirname(current)) === 'node_modules') {
      const manifestPath = join(current, 'package.json')
      if (existsSync(manifestPath)) return current
    }
    if (basename(dirname(dirname(current))) === 'node_modules' && basename(dirname(current)).startsWith('@')) {
      const manifestPath = join(current, 'package.json')
      if (existsSync(manifestPath)) return current
    }
    current = dirname(current)
  }
  return undefined
}

function repositoryUrl(manifest, identity) {
  const declared = typeof manifest.repository === 'string'
    ? manifest.repository
    : manifest.repository?.url
  if (typeof declared === 'string' && declared.trim()) {
    return declared
      .replace(/^git\+/u, '')
      .replace(/^git:\/\/github\.com\//u, 'https://github.com/')
      .replace(/\.git$/u, '')
  }
  return `https://www.npmjs.com/package/${encodeURIComponent(identity.slice(0, identity.lastIndexOf('@')))}`
}

function inferredLicense(text) {
  if (/MIT License/iu.test(text)) return 'MIT'
  if (/The ISC License/iu.test(text)) return 'ISC'
  if (/Apache License[\s\S]{0,80}Version 2\.0/iu.test(text)) return 'Apache-2.0'
  return undefined
}

function safeDirectoryName(identity) {
  return identity.replace(/[^0-9A-Za-z._-]+/gu, '__')
}

function escapeTableCell(value) {
  return String(value).replaceAll('|', '\\|').replaceAll('\n', ' ')
}

async function discoverLicenseFiles(packageRoot) {
  const entries = await readdir(packageRoot, { withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile() && LicenseFileName.test(entry.name))
    .map((entry) => join(packageRoot, entry.name))
    .sort()
}

async function bundledPackageRoots(repositoryRoot, metafilePath) {
  const metafile = await readJsonFile(metafilePath)
  const roots = new Set()
  for (const inputPath of Object.keys(metafile.inputs ?? {})) {
    if (!inputPath.includes('node_modules')) continue
    const packageRoot = packageRootForBundledInput(repositoryRoot, inputPath)
    if (packageRoot) roots.add(await realpath(packageRoot))
  }
  return [...roots].sort()
}

async function normalizePackageComponent(component) {
  const packageRoot = await realpath(component.packageRoot)
  const manifest = await readJsonFile(join(packageRoot, 'package.json'))
  if (typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
    throw new Error(`Third-party package has invalid identity: ${packageRoot}`)
  }
  return {
    identity: `${manifest.name}@${manifest.version}`,
    license: typeof manifest.license === 'string' ? manifest.license.trim() : '',
    licenseFiles: [
      ...(await discoverLicenseFiles(packageRoot)),
      ...(component.additionalLicenseFiles ?? []),
    ],
    name: manifest.name,
    packageRoot,
    source: repositoryUrl(manifest, `${manifest.name}@${manifest.version}`),
    version: manifest.version,
  }
}

async function copyComponentLicenses({ component, licenseRoot, override, overrideRoot }) {
  let licenseFiles = [...new Set(component.licenseFiles)]
  let license = component.license
  let source = component.source

  if (licenseFiles.length === 0 && override) {
    licenseFiles = [join(overrideRoot, override.licenseFile)]
    license ||= override.license
    source = override.source ?? source
  }
  if (licenseFiles.length === 0) {
    throw new Error(`${component.identity} is bundled without a complete license file`)
  }

  if (!license) {
    for (const licenseFile of licenseFiles) {
      license = inferredLicense(await readFile(licenseFile, 'utf8'))
      if (license) break
    }
  }
  if (!license) {
    throw new Error(`${component.identity} is bundled without recognizable license metadata`)
  }

  const destination = join(licenseRoot, safeDirectoryName(component.identity))
  await mkdir(destination, { recursive: true })
  const copiedNames = []
  for (const [index, licenseFile] of licenseFiles.entries()) {
    const sourceName = basename(licenseFile)
    const destinationName = copiedNames.includes(sourceName)
      ? `${index + 1}-${sourceName}`
      : sourceName
    await copyFile(licenseFile, join(destination, destinationName))
    copiedNames.push(destinationName)
  }
  await writeFile(
    join(destination, 'METADATA.json'),
    `${JSON.stringify({
      name: component.name,
      version: component.version,
      license,
      source,
      licenseFiles: copiedNames,
    }, null, 2)}\n`,
  )
  return { ...component, license, source, copiedNames }
}

async function stageThirdPartyLicenses({
  additionalPackages = [],
  bunVersion,
  metafilePath,
  packRoot,
  productRoot,
  repositoryRoot,
}) {
  const overrideFile = join(productRoot, 'third-party-licenses', 'overrides.json')
  const overrideRoot = dirname(overrideFile)
  const overrides = await readJsonFile(overrideFile)
  const roots = await bundledPackageRoots(repositoryRoot, metafilePath)
  const components = new Map()

  for (const packageRoot of roots) {
    const component = await normalizePackageComponent({ packageRoot })
    if (!component.name.startsWith('@velaros-ai/')) components.set(component.identity, component)
  }
  for (const additionalPackage of additionalPackages) {
    const component = await normalizePackageComponent(additionalPackage)
    if (component.name.startsWith('@velaros-ai/')) continue
    const existing = components.get(component.identity)
    components.set(component.identity, existing
      ? {
          ...existing,
          licenseFiles: [...existing.licenseFiles, ...component.licenseFiles],
        }
      : component)
  }

  const bunIdentity = `bun@${bunVersion}`
  const bunOverride = overrides[bunIdentity]
  if (!bunOverride) throw new Error(`Missing pinned Bun license metadata for ${bunIdentity}`)
  components.set(bunIdentity, {
    identity: bunIdentity,
    license: bunOverride.license,
    licenseFiles: [],
    name: 'Bun runtime',
    source: bunOverride.source,
    version: bunVersion,
  })

  const licenseRoot = join(packRoot, 'THIRD_PARTY_LICENSES')
  await mkdir(licenseRoot, { recursive: true })
  const staged = []
  for (const component of [...components.values()].sort((left, right) =>
    left.identity.localeCompare(right.identity)
  )) {
    staged.push(await copyComponentLicenses({
      component,
      licenseRoot,
      override: overrides[component.identity],
      overrideRoot,
    }))
  }

  const lines = [
    '# Third-party notices for Velar Document Renderer',
    '',
    'This file is generated from the exact JavaScript bundle inputs and runtime',
    'components staged into this archive. Upstream license and notice files plus',
    'per-component metadata are stored in `THIRD_PARTY_LICENSES/`.',
    '',
    '| Component | License | Source | License files |',
    '| --- | --- | --- | --- |',
    ...staged.map((component) => {
      const directory = safeDirectoryName(component.identity)
      const files = component.copiedNames
        .map((file) => `THIRD_PARTY_LICENSES/${directory}/${file}`)
        .join(', ')
      return `| ${escapeTableCell(component.identity)} | ${escapeTableCell(component.license)} | ${escapeTableCell(component.source)} | ${escapeTableCell(files)} |`
    }),
    '',
  ]
  const noticePath = join(packRoot, 'THIRD_PARTY_NOTICES.md')
  await writeFile(noticePath, lines.join('\n'))
  return {
    componentCount: staged.length,
    licenseRoot,
    noticePath,
    components: staged.map(({ identity, license, source, copiedNames }) => ({
      identity,
      license,
      source,
      licenseFiles: copiedNames,
    })),
  }
}

export {
  bundledPackageRoots,
  packageRootForBundledInput,
  stageThirdPartyLicenses,
}
