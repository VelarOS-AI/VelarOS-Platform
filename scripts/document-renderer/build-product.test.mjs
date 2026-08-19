import assert from 'node:assert/strict'
import test from 'node:test'

import {
  artifactTrust,
  capabilityPackManifest,
  currentTarget,
  launcherScript,
  macCodesignArguments,
  parseArguments,
} from './build-product.mjs'

test('Document Renderer packaging only accepts native release targets', () => {
  assert.equal(currentTarget({ platform: 'darwin', arch: 'arm64' }), 'darwin-arm64')
  assert.equal(currentTarget({ platform: 'win32', arch: 'x64' }), 'win32-x64')
  assert.equal(currentTarget({ platform: 'linux', arch: 'x64' }), 'linux-x64')
  assert.throws(
    () => currentTarget({ platform: 'darwin', arch: 'x64' }),
    /must be built natively/u,
  )
})

test('capability manifest keeps rendering outside Host', () => {
  const manifest = capabilityPackManifest('0.1.0', 'darwin-arm64', 'renderer')
  assert.equal(manifest.integration.kind, 'external-command')
  assert.equal(manifest.integration.bundledWithHost, false)
  assert.equal(manifest.integration.registeredByHost, false)
  assert.equal(manifest.permissions.processExecution, false)
})

test('launchers load only pack-local runtime and native rendering code', () => {
  const unix = launcherScript('darwin-arm64')
  assert.match(unix, /runtime\/bun/u)
  assert.match(unix, /NAPI_RS_NATIVE_LIBRARY_PATH/u)
  const windows = launcherScript('win32-x64')
  assert.match(windows, /runtime\\bun\.exe/u)
  assert.match(windows, /canvas\.node/u)
})

test('macOS signing modes remain explicit', () => {
  assert.deepEqual(parseArguments(['--notarize']), { notarize: true, adHoc: false })
  assert.deepEqual(parseArguments(['--adhoc']), { notarize: false, adHoc: true })
  assert.throws(
    () => parseArguments(['--notarize', '--adhoc']),
    /cannot be used together/u,
  )
  assert.deepEqual(artifactTrust('darwin-arm64', { notarize: true, adHoc: false }), {
    signature: 'developer-id',
    notarized: true,
  })
  assert.deepEqual(macCodesignArguments('-', true), [
    '--force',
    '--options',
    'runtime',
    '--sign',
    '-',
  ])
})
