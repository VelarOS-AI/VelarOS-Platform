/**
 * @test-meta
 * title: Sandbox 暂存后的提交复核
 * summary: 在隔离子进程内注入 copyFile 的并发修改，确认源文件、镜像或暂存内容漂移都不会被提交。
 * area: safety
 */
import { expect, test } from 'bun:test'

const mirrorModule = new URL('../utils/mirror.ts', import.meta.url).href

for (const mutation of ['source', 'mirror', 'staged', 'cancel-before-rename', 'none'] as const) {
  test(`暂存完成后核对 ${mutation} 内容；冲突保留源文件并清理暂存`, async () => {
    const script = `
      import fs from 'node:fs';
      import { mock } from 'bun:test';
      import { AppError } from '@velaros-ai/core/error';
      import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { syncBuiltinESMExports } from 'node:module';
      const base = await mkdtemp(join(tmpdir(), 'sandbox-staging-test-'));
      const source = join(base, 'source'), root = join(base, 'mirror');
      await mkdir(source); await mkdir(root);
      const sourceFile = join(source, 'note.txt'), mirrorFile = join(root, 'note.txt');
      await writeFile(sourceFile, 'original'); await writeFile(mirrorFile, 'sandbox-plan');
      const originalCopy = fs.promises.copyFile;
      const originalMkdir = fs.promises.mkdir;
      const controller = new AbortController();
      let raced = false;
      const injectedCopy = async (...args) => {
        await originalCopy(...args);
        if (String(args[1]).includes('.velaros-sandbox-') && !raced) {
          raced = true;
          const mutation = ${JSON.stringify(mutation)};
          if (mutation === 'source') await writeFile(sourceFile, 'external-after-validation');
          if (mutation === 'mirror') await writeFile(mirrorFile, 'late-mirror-content');
          if (mutation === 'staged') await writeFile(args[1], 'tampered-staging');
        }
      };
      mock.module('node:fs/promises', () => ({ ...fs.promises, copyFile: injectedCopy,
        mkdir: async (...args) => {
          const result = await originalMkdir(...args);
          if (raced && String(args[0]) === source && ${JSON.stringify(mutation)} === 'cancel-before-rename')
            controller.abort(new AppError('CANCELLED', 'fixture abort before rename'));
          return result;
        }
      }));
      try {
        const { applyMirrorChanges, scanTree } = await import(${JSON.stringify(mirrorModule)});
        const manifest = { version: 1, record: { id: 'fixture', source, root }, files: await scanTree(source), mirror: {} };
        let outcome;
        try {
          outcome = { value: await applyMirrorChanges(manifest, {created: [], modified: ['note.txt'], deleted: []}, controller.signal) };
        } catch (error) {
          outcome = { code: error.code, message: error.message, context: error.context };
        }
        console.log(JSON.stringify({ raced, outcome, content: await readFile(sourceFile, 'utf8'), files: await readdir(source) }));
      } finally {
        fs.promises.copyFile = originalCopy; syncBuiltinESMExports();
        await rm(base, { recursive: true, force: true });
      }
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
    expect(result.raced).toBe(true)
    expect(result.files).toEqual(['note.txt'])
    if (mutation === 'none') {
      expect(result.outcome.value.modified).toEqual(['note.txt'])
      expect(result.content).toBe('sandbox-plan')
    } else {
      expect(result.outcome.code).toMatch(/CONFLICT|CHANGED|CANCELLED/)
      expect(result.outcome.context.executionOutcome).toBe('not-applied')
      expect(result.content).toBe(mutation === 'source' ? 'external-after-validation' : 'original')
    }
  })
}
