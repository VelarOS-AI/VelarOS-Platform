// 在独占目录打包并干净安装整体 Platform，禁止借用 workspace 内部包。
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { safePackPackage, runGuardedCommand } from './safe-package-pack.mjs'
import { platformModules } from './unified-platform-package.mjs'

const root = path.resolve(import.meta.dirname, '../..')
// 不继承 agent 的 Node loader，验证真实消费者解析。
delete process.env.NODE_OPTIONS
delete process.env.NODE_PATH
const destination = await mkdtemp(path.join(tmpdir(), 'velaros-unified-check-'))
const consumer = path.join(destination, 'consumer')
await mkdir(consumer)
console.log(`Unified verification directory: ${destination}`)
await safePackPackage({
  packageDirectory: path.join(root, 'packages/velaros'),
  destination,
  timeoutMs: 300_000,
})
const archives = (await readdir(destination)).filter((name) => name.endsWith('.tgz'))
assert.equal(archives.length, 1)
const archive = path.join(destination, archives[0])
await writeFile(
  path.join(consumer, 'package.json'),
  JSON.stringify({
    private: true,
    type: 'module',
    dependencies: { '@velaros-ai/velaros': archive, react: '19.2.4', '@types/react': '19.2.14' },
  })
)
await runGuardedCommand({
  command: 'bun',
  args: ['install', '--ignore-scripts'],
  cwd: consumer,
  timeoutMs: 300_000,
  operation: 'Clean unified Platform install',
})
const installed = path.join(consumer, 'node_modules/@velaros-ai/velaros')
const manifest = JSON.parse(await readFile(path.join(installed, 'package.json'), 'utf8'))
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'])
  assert.ok(
    !Object.keys(manifest[field] ?? {}).some((name) => name.startsWith('@velaros-ai/')),
    field
  )
assert.deepEqual((await readdir(path.join(consumer, 'node_modules/@velaros-ai'))).sort(), [
  'velaros',
])
for (const name of platformModules) {
  const original = JSON.parse(
    await readFile(path.join(root, 'packages', name, 'package.json'), 'utf8')
  )
  for (const key of Object.keys(original.exports))
    assert.ok(manifest.exports[`./${name}${key === '.' ? '' : key.slice(1)}`])
}
// 检查所有导出目标与声明，不允许旧内部包解析被宿主环境掩盖。
async function inspectTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) await inspectTree(file)
    else if (/\.[cm]?[jt]s$/u.test(entry.name)) {
      const text = await readFile(file, 'utf8')
      assert.ok(
        !/@velaros-ai\/(?:core|kernel|model|agent|context|script)(?=[/"'`])/u.test(text),
        file
      )
    }
  }
}
await inspectTree(installed)
async function assertTargets(target) {
  if (typeof target === 'string') {
    if (!target.includes('*')) await readFile(path.join(installed, target))
  } else if (target) for (const value of Object.values(target)) await assertTargets(value)
}
for (const target of Object.values(manifest.exports)) await assertTargets(target)
for (const target of Object.values(manifest.bin ?? {})) await readFile(path.join(installed, target))

const probe = `import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
const require=createRequire(import.meta.url);
const manifest=JSON.parse(await readFile(require.resolve('@velaros-ai/velaros/package.json'),'utf8'));
let count=0;
for(const [key,target] of Object.entries(manifest.exports)) {
 if(key.includes('*') || typeof target==='string' || key==='./browser/electron') continue;
 const spec='@velaros-ai/velaros'+(key==='.'?'':key.slice(1));
 await import(spec); count++;
}
const script=await import('@velaros-ai/velaros/script');
const defaults=script.nodeRuntimePackages.defaults();assert.ok(defaults.length>10);
assert.ok(script.nodeRuntimePackages.references(defaults).every(x=>!x.error));
const skill=require.resolve('@velaros-ai/velaros/skill-jsts/package.json');
assert.ok((await readFile(skill.replace('package.json','SKILL.md'),'utf8')).length>100);
console.log(JSON.stringify({importedEntries:count,defaultPackages:defaults.length,skill}));`
await writeFile(path.join(consumer, 'probe.mjs'), probe)
const runtime = await runGuardedCommand({
  command: process.execPath,
  args: ['probe.mjs'],
  cwd: consumer,
  timeoutMs: 120_000,
  operation: 'Unified Node entry and resources probe',
})
console.log(runtime.stdout)
const entries = Object.entries(manifest.exports).filter(
  ([key, target]) => !key.includes('*') && target?.types
)
await writeFile(
  path.join(consumer, 'types.mts'),
  entries
    .map(
      ([key], i) =>
        `import * as e${i} from '@velaros-ai/velaros${key === '.' ? '' : key.slice(1)}'; export type E${i}=typeof e${i};`
    )
    .join('\n')
)
await runGuardedCommand({
  command: process.execPath,
  args: [
    path.join(consumer, 'node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--skipLibCheck',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--target',
    'ES2022',
    'types.mts',
  ],
  cwd: consumer,
  timeoutMs: 120_000,
  operation: 'Unified public declaration consumer',
})
await writeFile(
  path.join(consumer, 'browser.ts'),
  "export * from '@velaros-ai/velaros/agent'; export * from '@velaros-ai/velaros/renderer'; export * from '@velaros-ai/velaros/model/contracts';"
)
await runGuardedCommand({
  command: 'bun',
  args: ['build', './browser.ts', '--target=browser', '--outdir=browser-output'],
  cwd: consumer,
  timeoutMs: 120_000,
  operation: 'Unified browser surface bundle',
})
const sha256 = createHash('sha256')
  .update(await readFile(archive))
  .digest('hex')
await writeFile(
  path.join(destination, 'receipt.json'),
  JSON.stringify(
    {
      archive,
      sha256,
      consumer,
      runtime: runtime.stdout,
      declarationEntries: entries.length,
      browser: true,
    },
    null,
    2
  )
)
console.log(`PASS unified Platform: ${archive}\nSHA256 ${sha256}`)
