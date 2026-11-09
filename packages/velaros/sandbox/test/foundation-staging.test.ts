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
        const manifest = { version: 2, record: { id: 'fixture', source, root }, files: await scanTree(source), mirror: {} };
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

test('暂存清理失败保留成功提交事实，也不覆盖此前的部分提交错误', async () => {
  const script = `
    import fs from 'node:fs';
    import { mock } from 'bun:test';
    import { AppError } from '@velaros-ai/core/error';
    import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { basename, dirname, join } from 'node:path';
    const base = await mkdtemp(join(tmpdir(), 'sandbox-cleanup-failure-'));
    const originalRename = fs.promises.rename;
    const originalRm = fs.promises.rm;
    let active;
    mock.module('node:fs/promises', () => ({ ...fs.promises,
      rename: async (...args) => {
        if (active?.partial && String(args[1]) === join(active.source, 'second.txt'))
          throw active.commitError;
        return originalRename(...args);
      },
      rm: async (...args) => {
        const target = String(args[0]);
        if (active && dirname(target) === active.source && basename(target).startsWith('.velaros-sandbox-'))
          throw active.cleanupError;
        return originalRm(...args);
      }
    }));
    try {
      const { applyMirrorChanges, scanTree } = await import(${JSON.stringify(mirrorModule)});
      const outcomes = [];
      for (const partial of [false, true]) {
        const directory = join(base, partial ? 'partial' : 'complete');
        const source = join(directory, 'source'), root = join(directory, 'mirror');
        await mkdir(source, { recursive: true }); await mkdir(root);
        for (const name of ['first.txt', 'second.txt']) {
          await writeFile(join(source, name), 'original');
          await writeFile(join(root, name), 'sandbox-plan');
        }
        const commitError = new AppError('PERMISSION', 'fixture second commit failed');
        const cleanupError = new AppError('UNAVAILABLE', 'fixture staging cleanup failed');
        active = { source, partial, commitError, cleanupError };
        const manifest = { version: 2, record: { id: 'fixture', source, root }, files: await scanTree(source), mirror: {} };
        try {
          await applyMirrorChanges(manifest, { created: [], modified: ['first.txt', 'second.txt'], deleted: [] });
          throw new Error('fixture expected cleanup failure');
        } catch (error) {
          outcomes.push({
            partial, code: error.code, message: error.message, context: error.context,
            originalCommitPreserved: error.cause?.cause === commitError,
            cleanupPreserved: error.context?.cleanupError === cleanupError,
            first: await readFile(join(source, 'first.txt'), 'utf8'),
            second: await readFile(join(source, 'second.txt'), 'utf8'),
            retainedStages: (await readdir(source)).filter(name => name.startsWith('.velaros-sandbox-')).length,
          });
        }
        active = undefined;
      }
      console.log(JSON.stringify(outcomes));
    } finally {
      await originalRm(base, { recursive: true, force: true });
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
  const outcomes = JSON.parse(stdout)
  expect(outcomes).toHaveLength(2)
  for (const outcome of outcomes) {
    expect(outcome.context.executionOutcome).toBe('failed')
    expect(outcome.context.applied).toEqual(
      outcome.partial ? ['first.txt'] : ['first.txt', 'second.txt']
    )
    expect(outcome.cleanupPreserved).toBe(true)
    expect(outcome.message).toContain('fixture staging cleanup failed')
    expect(outcome.retainedStages).toBe(1)
    expect(outcome.first).toBe('sandbox-plan')
    expect(outcome.second).toBe(outcome.partial ? 'original' : 'sandbox-plan')
    if (outcome.partial) {
      expect(outcome.code).toBe('PERMISSION')
      expect(outcome.originalCommitPreserved).toBe(true)
      expect(outcome.message).toContain('fixture second commit failed')
    } else {
      expect(outcome.code).toBe('UNAVAILABLE')
      expect(outcome.message).not.toContain('后面的没落')
    }
  }
})
