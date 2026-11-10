import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const expected = JSON.parse(await readFile(new URL('./expected-release-pair.json', import.meta.url), 'utf8'))
const base = expected.find((item) => item.name === '@velaros-ai/velaros')
const capabilities = expected.find((item) => item.name === '@velaros-ai/capabilities')
const extensionRequire = createRequire(import.meta.resolve('@velaros-ai/capabilities/project'))
const topLevelResolvedBase = await realpath(fileURLToPath(import.meta.resolve('@velaros-ai/velaros/package.json')))
const extensionResolvedBase = await realpath(extensionRequire.resolve('@velaros-ai/velaros/package.json'))
const resolvedCapabilities = await realpath(fileURLToPath(import.meta.resolve('@velaros-ai/capabilities/package.json')))
const consumer = await realpath(process.cwd())
for (const file of [topLevelResolvedBase, extensionResolvedBase, resolvedCapabilities]) {
  const relative = path.relative(path.join(consumer, 'node_modules'), file)
  assert(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}
assert.equal(topLevelResolvedBase, extensionResolvedBase)
const baseSource = await readFile(topLevelResolvedBase, 'utf8')
const capabilitiesSource = await readFile(resolvedCapabilities, 'utf8')
const baseManifest = JSON.parse(baseSource)
const capabilitiesManifest = JSON.parse(capabilitiesSource)
assert.equal(baseManifest.name, base.name)
assert.equal(baseManifest.version, base.version)
assert.equal(capabilitiesManifest.name, capabilities.name)
assert.equal(capabilitiesManifest.version, capabilities.version)
assert.equal(capabilitiesManifest.dependencies?.[base.name], base.url)
assert.equal(capabilitiesManifest.peerDependencies?.[base.name], undefined)
assert.equal(capabilitiesManifest.optionalDependencies?.[base.name], undefined)
for (const manifest of [baseManifest, capabilitiesManifest]) {
  assert.equal(manifest.overrides, undefined)
  assert.equal(manifest.resolutions, undefined)
}
console.log(JSON.stringify({
  sameBaseInstance: true, baseVersion: baseManifest.version, capabilitiesVersion: capabilitiesManifest.version,
  topLevelResolvedBase, extensionResolvedBase, resolvedCapabilities,
  baseManifestSha256: createHash('sha256').update(baseSource).digest('hex'),
  capabilitiesManifestSha256: createHash('sha256').update(capabilitiesSource).digest('hex'),
}))
