import { expect, test } from 'bun:test'

test('parallel staging drains pending writes before failure cleanup', async () => {
  const moduleUrl = new URL('../utils/mirror.ts', import.meta.url).href
  const script = `
    import fs from 'node:fs';
    import { mock } from 'bun:test';
    import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    const base = await mkdtemp(join(tmpdir(), 'staging-drain-'));
    const source = join(base, 'source'), root = join(base, 'mirror');
    await mkdir(source); await mkdir(root);
    await writeFile(join(root, 'a'), 'a'); await writeFile(join(root, 'b'), 'b');
    const originalCopy = fs.promises.copyFile;
    let release;
    const started = new Promise(resolve => { release = resolve });
    let pending = 0, completed = 0;
    mock.module('node:fs/promises', () => ({ ...fs.promises, copyFile: async (...args) => {
      if (!String(args[1]).includes('.velaros-sandbox-')) return originalCopy(...args);
      if (String(args[0]).endsWith('/a') || String(args[0]).endsWith('\\\\a')) {
        await started;
        throw new Error('fixture staging failure');
      }
      pending++;
      release();
      try { await originalCopy(...args); completed++; } finally { pending--; }
    }}));
    try {
      const { applyMirrorChanges, scanTree } = await import(${JSON.stringify(moduleUrl)});
      const manifest = {version: 1, record: {id: 'fixture', source, root}, files: {}, mirror: await scanTree(root)};
      let failure;
      try { await applyMirrorChanges(manifest, {created: ['a', 'b'], modified: [], deleted: []}); }
      catch (error) { failure = {message: error.message, outcome: error.context.executionOutcome}; }
      console.log(JSON.stringify({failure, pending, completed, files: await readdir(source)}));
    } finally { await rm(base, {recursive: true, force: true}); }
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
  const result = JSON.parse(stdout)
  expect(result.failure.message).toContain('fixture staging failure')
  expect(result.failure.outcome).toBe('not-applied')
  expect(result.pending).toBe(0)
  expect(result.completed).toBe(1)
  expect(result.files).toEqual([])
})
