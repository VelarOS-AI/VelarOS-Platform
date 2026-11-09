import { expect, test } from 'bun:test'

test('遍历准备被取消后停止复制并关闭当前 IO，不继续扫完整棵树', async () => {
  const moduleUrl = new URL('../utils/mirror.ts', import.meta.url).href
  const script = `
import fs from 'node:fs';
import { mock } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'sandbox-prepare-cancel-'));
const source = join(directory, 'source'), root = join(directory, 'mirror');
await mkdir(source); await mkdir(root);
for (let index = 0; index < 40; index++) await writeFile(join(source, String(index)), 'content');
const controller = new AbortController();
const originalReadDir = fs.promises.readdir;
const originalCopy = fs.promises.copyFile;
let copies = 0, reads = 0;
mock.module('node:fs/promises', () => ({ ...fs.promises,
  readdir: async (...args) => {
    const entries = await originalReadDir(...args);
    if (String(args[0]) === source) { reads++; controller.abort(); }
    return entries;
  },
  copyFile: async (...args) => { copies++; return originalCopy(...args); }
}));
try {
  const { mirrorTree } = await import(${JSON.stringify(moduleUrl)});
  const error = await mirrorTree(source, root, {ignored:'copy', shouldSkip: async () => false, limits: {files:100,bytes:10000}, signal:controller.signal}).then(() => null, error => ({name:error.name}));
  console.log(JSON.stringify({error, copies, reads, files:await readdir(root)}));
} finally { await rm(directory, {recursive:true,force:true}); }
`
  const child = Bun.spawn([process.execPath, '--eval', script], { stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
  expect(JSON.parse(stdout)).toEqual({
    error: { name: 'AbortError' },
    copies: 0,
    reads: 1,
    files: [],
  })
})

for (const stage of ['tree', 'tmp']) {
  test(`创建 ${stage} 目录失败时回收自己分配的半目录`, async () => {
    const moduleUrl = new URL('../impl/LocalSandboxHost.ts', import.meta.url).href
    const script = `
import fs from 'node:fs';
import { mock } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
const directory = await mkdtemp(join(tmpdir(), 'sandbox-allocate-failure-'));
const source = join(directory, 'source'), base = join(directory, 'boxes');
await mkdir(source); await writeFile(join(source,'note'),'original');
const originalMkdir = fs.promises.mkdir;
mock.module('node:fs/promises', () => ({ ...fs.promises, mkdir: async (...args) => {
  if (basename(String(args[0])) === ${JSON.stringify(stage)}) throw Object.assign(new Error('fixture mkdir failure'), {code:'EACCES'});
  return originalMkdir(...args);
}}));
try {
  const { LocalSandboxHost } = await import(${JSON.stringify(moduleUrl)});
  const host = new LocalSandboxHost({baseDir:base});
  try {
    const failure = await host.createSandbox({source}).then(() => null,error => error.message);
    console.log(JSON.stringify({failure, remaining:await readdir(base), records:host.listSandboxes()}));
  } finally { await host.dispose(); }
} finally { await rm(directory,{recursive:true,force:true}); }
`
    const child = Bun.spawn([process.execPath, '--eval', script], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' })
    expect(JSON.parse(stdout)).toEqual({
      failure: 'fixture mkdir failure',
      remaining: [],
      records: [],
    })
  })
}
