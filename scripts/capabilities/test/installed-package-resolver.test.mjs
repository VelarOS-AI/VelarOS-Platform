import { expect, test } from 'bun:test'
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { InstalledPackageResolver } from '../lib/installed-package-resolver.mjs'

const KernelPackageName = '@velaros-ai/kernel'
const TokenizerName = 'gpt-tokenizer'

async function writeManifest(directory, manifest) {
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, 'package.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

async function linkInstalledPackage(workspaceDirectory, packageName, source) {
  const target = path.join(
    workspaceDirectory,
    'node_modules',
    ...packageName.split('/'),
  )
  await mkdir(path.dirname(target), { recursive: true })
  await symlink(
    source,
    target,
    process.platform === 'win32' ? 'junction' : 'dir',
  )
}

test('resolves a fresh Bun layout from a workspace that declares the package', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cap-installed-resolver-'))
  try {
    const declaredWorkspace = path.join(root, 'packages', 'browser-runtime')
    const undeclaredWorkspace = path.join(root, 'packages', 'browser-core')
    const installedKernel = path.join(root, 'registry-install', 'kernel')
    await writeManifest(declaredWorkspace, {
      name: '@example/browser-runtime',
      dependencies: { [KernelPackageName]: '^0.1.0' },
    })
    await writeManifest(undeclaredWorkspace, {
      name: '@example/browser-core',
      dependencies: {},
    })
    await writeManifest(installedKernel, {
      name: KernelPackageName,
      version: '0.1.0',
    })
    await linkInstalledPackage(declaredWorkspace, KernelPackageName, installedKernel)

    const resolver = new InstalledPackageResolver({
      repositoryRoot: root,
      workspaceDirectories: [undeclaredWorkspace, declaredWorkspace],
    })

    expect(await resolver.resolve(KernelPackageName)).toBe(await realpath(installedKernel))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prefers a root installation over declared workspace installations', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cap-installed-resolver-root-'))
  try {
    const workspace = path.join(root, 'packages', 'browser-runtime')
    const rootInstall = path.join(root, 'registry-install', 'root-sdk')
    const workspaceInstall = path.join(root, 'registry-install', 'workspace-sdk')
    await writeManifest(workspace, {
      name: '@example/browser-runtime',
      dependencies: { [KernelPackageName]: '^0.1.0' },
    })
    await writeManifest(rootInstall, { name: KernelPackageName, version: '0.1.0' })
    await writeManifest(workspaceInstall, { name: KernelPackageName, version: '0.1.0' })
    await linkInstalledPackage(root, KernelPackageName, rootInstall)
    await linkInstalledPackage(workspace, KernelPackageName, workspaceInstall)

    const resolver = new InstalledPackageResolver({
      repositoryRoot: root,
      workspaceDirectories: [workspace],
    })

    expect(await resolver.resolve(KernelPackageName)).toBe(await realpath(rootInstall))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('resolves a transitive dependency through its declaring package graph', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cap-installed-resolver-transitive-'))
  try {
    const workspace = path.join(root, 'packages', 'browser-core')
    const installedCore = path.join(root, 'registry-install', 'core')
    const installedTokenizer = path.join(root, 'registry-install', 'gpt-tokenizer')
    await writeManifest(workspace, {
      name: '@example/browser-core',
      dependencies: { '@velaros-ai/core': '^0.4.0' },
    })
    await writeManifest(installedCore, {
      name: '@velaros-ai/core',
      version: '0.4.0',
      dependencies: { [TokenizerName]: '^3.0.1' },
      main: './index.js',
    })
    await writeFile(path.join(installedCore, 'index.js'), 'export {}\n')
    await writeManifest(installedTokenizer, {
      name: TokenizerName,
      version: '3.4.0',
      main: './index.js',
    })
    await writeFile(path.join(installedTokenizer, 'index.js'), 'export {}\n')
    await linkInstalledPackage(installedCore, TokenizerName, installedTokenizer)

    const resolver = new InstalledPackageResolver({
      repositoryRoot: root,
      workspaceDirectories: [workspace],
    })

    expect(
      await resolver.resolve(
        TokenizerName,
        { declaringPackageDirectories: [installedCore] },
      ),
    ).toBe(await realpath(installedTokenizer))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
