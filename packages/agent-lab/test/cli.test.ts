import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { archive } from '../spec/support.js'
import { agentLabCli, labArchives } from '../src/index.js'

/** `run` 用不到时给一个会当场报错的加载器：本包不做动态 import。 */
const options = {
  loadRuntime: {
    load: async (): Promise<never> => {
      throw new Error('测试里不加载套件运行时')
    },
  },
}

async function withDirectory(verify: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-cli-'))
  try {
    await verify(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('public CLI', () => {
  test('exposes standard help without requiring implementation knowledge', async () => {
    for (const argument of ['--help', '-h', 'help']) {
      const result = await agentLabCli.run([argument], options)
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain('VelarOS Agent Lab')
      expect(result.stdout).toContain('validate <journey|job|run|real-task|case>')
      expect(result.stdout).toContain('audit-record <record.json>')
      expect(result.stdout).toContain('certify <文件或目录...>')
    }
  })

  test('ships an executable shell that only wires the process into the package', async () => {
    const source = await readFile(new URL('../bin/velaros-agent-lab.mjs', import.meta.url), 'utf8')
    expect(source.startsWith('#!/usr/bin/env node')).toBe(true)
    expect(source).toContain('dist/index.js')
    expect(source).toContain('agentLabCli.run(process.argv.slice(2)')
  })

  test('reports a current archive with unknown values through the real file boundary', async () => {
    await withDirectory(async (root) => {
      await labArchives.writeRunArchive(root, archive({ score: null }))
      const output = join(root, 'report.html')
      const result = await agentLabCli.run(['report', root, '--output', output], {
        ...options,
        now: () => 1,
      })
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe('')
      expect(await readFile(output, 'utf8')).toContain('data-value="null">—</span>')
    })
  })

  test('bad current archives fail report and compare without replacing an existing report', async () => {
    await withDirectory(async (root) => {
      const value = archive()
      const directory = join(root, 'run')
      await mkdir(directory)
      const report = join(directory, 'report.json')
      await writeFile(join(directory, 'progress.json'), JSON.stringify(value))
      const output = join(root, 'report.html')
      await writeFile(output, 'keep the previous report')
      for (const text of [
        '{',
        JSON.stringify({ ...value, unexpected: true }),
        JSON.stringify({ manifest: { runId: 'old' }, rounds: [] }),
      ]) {
        await writeFile(report, text)
        for (const path of [report, directory, root]) {
          const result = await agentLabCli.run(['report', path, '--output', output], options)
          expect(result.exitCode).toBe(1)
          expect(result.stdout).toBe('')
          expect(result.stderr.length).toBeGreaterThan(0)
        }
        const comparison = await agentLabCli.run(['compare', root, '--a', 'a', '--b', 'b'], options)
        expect(comparison.exitCode).toBe(1)
        expect(await readFile(output, 'utf8')).toBe('keep the previous report')
        expect(await readFile(report, 'utf8')).toBe(text)
      }
      await rm(report)
      await mkdir(report)
      const unreadable = await agentLabCli.run(['report', root, '--output', output], options)
      expect(unreadable.exitCode).toBe(1)
      expect(unreadable.stdout).toBe('')
      expect(await readFile(output, 'utf8')).toBe('keep the previous report')
    })
  })

  test('a progress-only directory cannot masquerade as a successful report', async () => {
    await withDirectory(async (root) => {
      await writeFile(join(root, 'progress.json'), JSON.stringify(archive()))
      const result = await agentLabCli.run(
        ['report', root, '--output', join(root, 'report.html')],
        options
      )
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain('没有找到任何当前 v3 归档')
    })
  })

  test('comparison exits two for an inconclusive current sample and zero for a conclusive paired result', async () => {
    await withDirectory(async (root) => {
      for (const executorId of ['a', 'b']) {
        await labArchives.writeRunArchive(
          root,
          archive({ executorId, journeyId: 'j1', groupId: 'g1', score: executorId === 'a' ? 1 : 0 })
        )
      }
      const one = await agentLabCli.run(['compare', root, '--a', 'a', '--b', 'b'], options)
      expect(one.exitCode).toBe(2)
      expect(one.stderr).toBe('')
      expect(JSON.parse(one.stdout)).toMatchObject({
        decision: 'inconclusive',
        matchedPairs: 1,
        clusters: 1,
      })
      for (const executorId of ['a', 'b']) {
        await labArchives.writeRunArchive(
          root,
          archive({ executorId, journeyId: 'j2', groupId: 'g2', score: executorId === 'a' ? 1 : 0 })
        )
      }
      const two = await agentLabCli.run(['compare', root, '--a', 'a', '--b', 'b'], options)
      expect(two.exitCode).toBe(0)
      expect(two.stderr).toBe('')
      expect(JSON.parse(two.stdout)).toMatchObject({
        decision: 'a-better',
        matchedPairs: 2,
        clusters: 2,
      })
    })
  })
})
