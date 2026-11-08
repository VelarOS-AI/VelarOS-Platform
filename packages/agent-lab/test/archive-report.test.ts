import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { archive, observation } from '../spec/support.js'
import { labArchives, labReports } from '../src/index.js'
import { normalizeObservation } from '../src/utils/measure/normalize.js'
import {
  assertSelfContainedHtml,
  findExternalResourceViolations,
} from '../src/utils/render/html.js'

async function withDirectory(verify: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'agent-lab-archive-'))
  try {
    await verify(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('current archive boundaries and reports', () => {
  test('rejects nonportable run directories before IO and preserves valid identity bytes', async () => {
    await withDirectory(async (root) => {
      for (const runId of ['run:one', 'run.', ' run', 'run ', '../escape']) {
        await assert.rejects(labArchives.writeRunArchive(root, archive({ runId })), {
          name: 'ZodError',
        })
        expect(await readdir(root)).toEqual([])
      }
      for (const runId of ['run-1._ok', '8edc8579-2e61-4e42-937b-3bb0563a4fb7']) {
        const value = archive({ runId })
        const path = await labArchives.writeRunArchive(root, value)
        expect(path).toBe(join(root, runId, 'report.json'))
        expect(await labArchives.readRunArchive(path)).toEqual(value)
      }
      const source = join(root, 'invalid.json')
      const bytes = JSON.stringify(archive({ runId: 'bad:identity' }))
      await writeFile(source, bytes)
      await assert.rejects(labArchives.readRunArchive(source), { name: 'ZodError' })
      expect(await readFile(source, 'utf8')).toBe(bytes)
    })
  })

  test('round-trips a strict v3 archive without rewriting its bytes', async () => {
    await withDirectory(async (root) => {
      const value = archive({ score: null })
      const path = await labArchives.writeRunArchive(root, value)
      const original = await readFile(path, 'utf8')
      expect(await labArchives.readRunArchive(path)).toEqual(value)
      expect(await labArchives.discoverRunArchives(root)).toEqual({
        archives: [{ directory: join(root, value.manifest.runId), path, archive: value }],
        skippedDirectories: 0,
      })
      expect(await readFile(path, 'utf8')).toBe(original)
    })
  })

  test('rejects old, malformed and extra-field reports without consulting progress or changing originals', async () => {
    await withDirectory(async (root) => {
      const value = archive()
      const report = join(root, 'report.json')
      const progress = join(root, 'progress.json')
      const progressBytes = JSON.stringify(value)
      await writeFile(progress, progressBytes)
      const invalid = [
        JSON.stringify([{ ok: true }]),
        JSON.stringify({ sessionId: 'old', rounds: [] }),
        JSON.stringify({ manifest: { runId: 'old' }, rounds: [] }),
        JSON.stringify({ ...value, unexpected: true }),
        JSON.stringify({ ...value, manifest: { ...value.manifest, unexpected: true } }),
        JSON.stringify({ ...value, manifest: { ...value.manifest, schema: 'agent-lab/run@2' } }),
        JSON.stringify({ unrelated: true }),
        '{',
      ]
      for (const text of invalid) {
        await writeFile(report, text)
        await assert.rejects(labArchives.readRunArchive(report))
        await assert.rejects(labArchives.discoverRunArchives(root))
        expect(await readFile(report, 'utf8')).toBe(text)
        expect(await readFile(progress, 'utf8')).toBe(progressBytes)
      }
    })
  })

  test('skips only missing reports and never discovers progress files', async () => {
    await withDirectory(async (root) => {
      expect(await labArchives.discoverRunArchives(root)).toEqual({
        archives: [],
        skippedDirectories: 0,
      })
      await assert.rejects(labArchives.readRunArchive(join(root, 'report.json')), {
        code: 'ENOENT',
      })
      await writeFile(join(root, 'progress.json'), JSON.stringify(archive()))
      const child = join(root, 'old-run')
      await mkdir(child)
      await writeFile(join(child, 'progress.json'), '{')
      expect(await labArchives.discoverRunArchives(root)).toEqual({
        archives: [],
        skippedDirectories: 1,
      })
    })
  })

  test('propagates real report read failures and rejects a bad child among valid runs', async () => {
    await withDirectory(async (root) => {
      const value = archive({ runId: 'valid-run' })
      await labArchives.writeRunArchive(root, value)
      const broken = join(root, 'broken-run')
      await mkdir(broken)
      await writeFile(join(broken, 'progress.json'), JSON.stringify(value))
      await mkdir(join(broken, 'report.json'))
      await assert.rejects(labArchives.readRunArchive(join(broken, 'report.json')))
      await assert.rejects(labArchives.discoverRunArchives(root))
      await rm(join(broken, 'report.json'), { recursive: true })
      await writeFile(join(broken, 'report.json'), JSON.stringify({ ...value, unexpected: true }))
      await assert.rejects(labArchives.discoverRunArchives(root))
    })
  })

  test('deduplicates cumulative debug snapshots by toolCallId', () => {
    const base = observation()
    const call = {
      id: 'call-1',
      turnId: 'turn-1',
      name: 'read',
      input: { path: '/a' },
      result: null,
      isError: null,
      startedAt: null,
      finishedAt: null,
    } as const
    const normalized = normalizeObservation({
      ...base,
      turns: [
        { id: 'turn-1', index: 0, toolCalls: [call], finishReasons: [] },
        {
          id: 'turn-2',
          index: 1,
          toolCalls: [{ ...call, turnId: 'turn-2' }],
          finishReasons: [],
        },
      ],
    })
    expect(normalized.turns.flatMap((turn) => turn.toolCalls)).toHaveLength(1)
  })

  test('renders deterministic self-contained v3 reports with honest unknown values', () => {
    const model = labReports.createRunReportModel(archive({ score: null }))
    const first = labReports.renderRunReportHtml([model], { generatedAt: 1 })
    const second = labReports.renderRunReportHtml([model], { generatedAt: 1 })
    expect(first).toBe(second)
    expect(findExternalResourceViolations(first)).toEqual([])
    expect(first).toContain('data-value="null">—</span>')
    expect(() =>
      assertSelfContainedHtml(`${first}<script src="https://bad.invalid/x.js"></script>`)
    ).toThrow()
  })
})
