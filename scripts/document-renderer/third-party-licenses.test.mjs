import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  packageRootForBundledInput,
  stageThirdPartyLicenses,
} from './third-party-licenses.mjs'

const MitLicense = `MIT License

Copyright (c) Example Contributor

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction.
`

async function writePackage(repositoryRoot, packageName, manifest, license = undefined) {
  const packageRoot = join(repositoryRoot, 'node_modules', ...packageName.split('/'))
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(join(packageRoot, 'index.js'), 'export default true\n')
  if (license) await writeFile(join(packageRoot, 'LICENSE'), license)
  return packageRoot
}

async function createFixture() {
  const repositoryRoot = await mkdtemp(join(tmpdir(), 'velaros-renderer-licenses-'))
  const productRoot = join(repositoryRoot, 'products', 'document-renderer')
  const overrideRoot = join(productRoot, 'third-party-licenses')
  await mkdir(overrideRoot, { recursive: true })
  await writeFile(join(overrideRoot, 'Bun-LICENSE.md'), MitLicense)
  await writeFile(join(overrideRoot, 'overrides.json'), `${JSON.stringify({
    'bun@1.2.3': {
      license: 'MIT',
      licenseFile: 'Bun-LICENSE.md',
      source: 'https://example.test/bun',
    },
  }, null, 2)}\n`)
  return { productRoot, repositoryRoot }
}

test('package root lookup handles scoped and unscoped bundle inputs', async () => {
  const fixture = await createFixture()
  try {
    const plain = await writePackage(fixture.repositoryRoot, 'plain', {
      name: 'plain', version: '1.0.0', license: 'MIT',
    }, MitLicense)
    const scoped = await writePackage(fixture.repositoryRoot, '@scope/scoped', {
      name: '@scope/scoped', version: '2.0.0', license: 'MIT',
    }, MitLicense)
    assert.equal(
      packageRootForBundledInput(fixture.repositoryRoot, 'node_modules/plain/index.js'),
      plain,
    )
    assert.equal(
      packageRootForBundledInput(fixture.repositoryRoot, 'node_modules/@scope/scoped/index.js'),
      scoped,
    )
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true })
  }
})

test('stages notices for bundle inputs, native additions, and the pinned Bun runtime', async () => {
  const fixture = await createFixture()
  try {
    const bundledRoot = await writePackage(fixture.repositoryRoot, 'bundled', {
      name: 'bundled',
      version: '1.0.0',
      license: 'MIT',
      repository: 'https://example.test/bundled.git',
    }, MitLicense)
    const nativeRoot = await writePackage(fixture.repositoryRoot, '@native/binary', {
      name: '@native/binary',
      version: '2.0.0',
      license: 'MIT',
    })
    const metafilePath = join(fixture.repositoryRoot, 'metafile.json')
    await writeFile(metafilePath, JSON.stringify({
      inputs: { 'node_modules/bundled/index.js': { bytes: 1 } },
    }))
    const packRoot = join(fixture.repositoryRoot, 'pack')
    const result = await stageThirdPartyLicenses({
      additionalPackages: [{
        packageRoot: nativeRoot,
        additionalLicenseFiles: [join(bundledRoot, 'LICENSE')],
      }],
      bunVersion: '1.2.3',
      metafilePath,
      packRoot,
      productRoot: fixture.productRoot,
      repositoryRoot: fixture.repositoryRoot,
    })

    assert.equal(result.componentCount, 3)
    const notice = await readFile(join(packRoot, 'THIRD_PARTY_NOTICES.md'), 'utf8')
    assert.match(notice, /bundled@1\.0\.0/u)
    assert.match(notice, /@native\/binary@2\.0\.0/u)
    assert.match(notice, /bun@1\.2\.3/u)
    await readFile(join(packRoot, 'THIRD_PARTY_LICENSES', 'bundled__1.0.0', 'LICENSE'))
    await readFile(join(packRoot, 'THIRD_PARTY_LICENSES', '__native__binary__2.0.0', 'LICENSE'))
    await readFile(join(packRoot, 'THIRD_PARTY_LICENSES', 'bun__1.2.3', 'Bun-LICENSE.md'))
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true })
  }
})

test('refuses a bundled package without a complete license text', async () => {
  const fixture = await createFixture()
  try {
    await writePackage(fixture.repositoryRoot, 'unlicensed', {
      name: 'unlicensed', version: '1.0.0', license: 'MIT',
    })
    const metafilePath = join(fixture.repositoryRoot, 'metafile.json')
    await writeFile(metafilePath, JSON.stringify({
      inputs: { 'node_modules/unlicensed/index.js': { bytes: 1 } },
    }))
    await assert.rejects(
      stageThirdPartyLicenses({
        bunVersion: '1.2.3',
        metafilePath,
        packRoot: join(fixture.repositoryRoot, 'pack'),
        productRoot: fixture.productRoot,
        repositoryRoot: fixture.repositoryRoot,
      }),
      /unlicensed@1\.0\.0 is bundled without a complete license file/u,
    )
  } finally {
    await rm(fixture.repositoryRoot, { recursive: true, force: true })
  }
})
