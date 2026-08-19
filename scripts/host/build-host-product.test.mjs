import assert from 'node:assert/strict'
import test from 'node:test'

import {
  artifactTrust,
  currentTarget,
  macInfoPlist,
  macLaunchScript,
  parseArguments,
} from './build-host-product.mjs'

test('Host product packaging only accepts native release targets', () => {
  assert.equal(
    currentTarget({ platform: 'darwin', arch: 'arm64' }),
    'darwin-arm64',
  )
  assert.equal(currentTarget({ platform: 'win32', arch: 'x64' }), 'win32-x64')
  assert.equal(currentTarget({ platform: 'linux', arch: 'x64' }), 'linux-x64')
  assert.throws(
    () => currentTarget({ platform: 'darwin', arch: 'x64' }),
    /must be built natively/u,
  )
})

test('macOS installer keeps Terminal as the Host interface', () => {
  const script = macLaunchScript()
  assert.match(script, /exec "\$RESOURCES_DIR\/bin\/velar-host"/u)
  assert.match(script, /VELAROS_HOST_RESOURCES_ROOT/u)
  assert.doesNotMatch(script, /https?:\/\//u)

  const plist = macInfoPlist('0.2.0')
  assert.match(plist, /com\.velaros\.host/u)
  assert.match(plist, /<string>0\.2\.0<\/string>/u)
})

test('macOS signing modes cannot be mixed', () => {
  assert.deepEqual(parseArguments(['--notarize']), {
    notarize: true,
    adHoc: false,
  })
  assert.deepEqual(parseArguments(['--adhoc']), {
    notarize: false,
    adHoc: true,
  })
  assert.throws(
    () => parseArguments(['--notarize', '--adhoc']),
    /cannot be used together/u,
  )
  assert.deepEqual(artifactTrust('darwin-arm64', { notarize: true, adHoc: false }), {
    signature: 'developer-id',
    notarized: true,
  })
  assert.deepEqual(artifactTrust('darwin-arm64', { notarize: false, adHoc: true }), {
    signature: 'ad-hoc',
    notarized: false,
  })
})
