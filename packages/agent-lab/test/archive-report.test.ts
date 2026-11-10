import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { archive, assertSelfContainedReport, observation } from '../spec/support.js'
import type { RunReportModel } from '../src/index.js'
import { labArchives, labReports } from '../src/index.js'
import { normalizeObservation } from '../src/utils/measure/normalize.js'

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

  test('INV-3 publishes each run once and accepts only identical serialized bytes', async () => {
    await withDirectory(async (root) => {
      const value = archive()
      const path = await labArchives.writeRunArchive(root, value)
      const original = await readFile(path)
      expect(await labArchives.writeRunArchive(root, structuredClone(value))).toBe(path)
      expect(await readFile(path)).toEqual(original)
      for (const changed of [
        { ...value, manifest: { ...value.manifest, finishedAt: 3 } },
        { ...value, extensions: { note: 'different evidence' } },
      ]) {
        await expect(labArchives.writeRunArchive(root, changed)).rejects.toThrow(
          '运行归档已存在且内容不同'
        )
        expect(await readFile(path)).toEqual(original)
      }
      expect(await readdir(join(root, value.manifest.runId))).toEqual(['report.json'])
    })
  })

  test('INV-3 keeps an existing archive byte-for-byte instead of normalizing it', async () => {
    await withDirectory(async (root) => {
      const value = archive()
      const path = await labArchives.writeRunArchive(root, value)
      const original = JSON.stringify(value)
      await writeFile(path, original)
      await expect(labArchives.writeRunArchive(root, value)).rejects.toThrow(
        '运行归档已存在且内容不同'
      )
      expect(await readFile(path, 'utf8')).toBe(original)
      expect(await readdir(join(root, value.manifest.runId))).toEqual(['report.json'])
    })
  })

  test('INV-3 concurrent different archives have one winner and cannot replace it', async () => {
    await withDirectory(async (root) => {
      const first = archive()
      const values = [first, { ...first, extensions: { note: 'competing evidence' } }]
      const outcomes = await Promise.allSettled(
        values.map((value) => labArchives.writeRunArchive(root, value))
      )
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
      expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1)
      const winner = outcomes.findIndex((outcome) => outcome.status === 'fulfilled')
      const path = join(root, first.manifest.runId, 'report.json')
      const published = await readFile(path)
      expect(await labArchives.readRunArchive(path)).toEqual(values[winner])
      await expect(labArchives.writeRunArchive(root, values[1 - winner]!)).rejects.toThrow(
        '运行归档已存在且内容不同'
      )
      expect(await readFile(path)).toEqual(published)
      expect(await readdir(join(root, first.manifest.runId))).toEqual(['report.json'])
    })
  })

  test('ordinary report files retain replacement writes', async () => {
    await withDirectory(async (root) => {
      const path = join(root, 'report.html')
      await labArchives.writeReportFile(path, 'previous report')
      expect(await labArchives.writeReportFile(path, 'updated report')).toBe(path)
      expect(await readFile(path, 'utf8')).toBe('updated report')
      expect(await readdir(root)).toEqual(['report.html'])
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
    assertSelfContainedReport(first)
    expect(first).toContain('data-value="null">—</span>')
  })

  test('renders escaped prose unchanged without treating code words or URLs as resources', () => {
    const prose =
      'undefined NaN fetch( XMLHttpRequest import( url( @import https://example.invalid/report'
    const payload = `${prose} <script src="https://bad.invalid/x.js">fetch('x')</script><img src=x onerror=alert(1)>`
    const base = labReports.createRunReportModel(archive({ score: null }))
    const model: RunReportModel = {
      ...base,
      journeyTitle: payload,
      executorLabel: payload,
      verdicts: [{ id: prose, level: 'information', title: payload, detail: payload }],
      gaps: [{ face: 'history', title: payload, effect: payload }],
      legs: base.legs.map((leg) => ({ ...leg, title: payload, settleKind: payload })),
    }
    const original = structuredClone(model)
    const html = labReports.renderRunReportHtml([model], { title: payload })
    assertSelfContainedReport(html)
    expect(html).toContain(prose)
    expect(html).toContain('&lt;script src=&quot;https://bad.invalid/x.js&quot;&gt;')
    expect(html).not.toContain('<wbr>')
    expect(html).toContain('overflow-wrap:anywhere')
    expect(html).toContain('data-value="null">—</span>')
    expect(model).toEqual(original)
  })

  test('checks actual executable, resource attribute and stylesheet contexts instead of report prose', () => {
    const html = labReports.renderRunReportHtml([labReports.createRunReportModel(archive())])
    assertSelfContainedReport(
      `${html}<p>https://example.invalid fetch( url( @import undefined NaN</p><a href="#local">local</a>`
    )
    for (const resource of [
      '<script>alert(1)</script>',
      '<script src="https://bad.invalid/x.js"></script>',
      '<img src="https://bad.invalid/x.png">',
      '<source srcset="https://bad.invalid/x.png 2x">',
      '<link rel="stylesheet" href="https://bad.invalid/x.css">',
      '<a href="https://bad.invalid">external</a>',
      '<svg><use xlink:href="https://bad.invalid/x.svg#id"></use></svg>',
      '<iframe srcdoc="hello"></iframe>',
      '<form action="https://bad.invalid"></form>',
      '<div onclick="alert(1)">event</div>',
      '<meta http-equiv="refresh" content="0;url=https://bad.invalid">',
      '<style>@import "https://bad.invalid/x.css";</style>',
      '<style>body{background:url(https://bad.invalid/x.png)}</style>',
      '<style>@font-face{font-family:remote;src:local(remote)}</style>',
      '<div style="background:url(https://bad.invalid/x.png)">style</div>',
    ])
      expect(() => assertSelfContainedReport(`${html}${resource}`)).toThrow()
  })

  test('rejects nonfinite numeric report values without confusing literal words, zero and unknown', () => {
    const base = labReports.createRunReportModel(archive({ score: null }))
    for (const value of [NaN, Infinity, -Infinity]) {
      const models = [
        ...[
          'completion',
          'passedLegs',
          'totalLegs',
          'journeyVersion',
          'durationMs',
          'toolCalls',
          'totalTokens',
          'costUsd',
          'drops',
        ].map((field) => ({ ...base, [field]: value })),
        { ...base, failureCounts: { loop: value } },
        ...['durationMs', 'score', 'toolCalls', 'contextPercent'].map((field) => ({
          ...base,
          legs: base.legs.map((leg) => ({ ...leg, [field]: value })),
        })),
      ]
      for (const model of models)
        expect(() => labReports.renderRunReportHtml([model])).toThrow('报告数值必须是有限数字')
      expect(() => labReports.renderRunReportHtml([base], { generatedAt: value })).toThrow()
    }
    expect(() =>
      labReports.renderRunReportHtml([
        { ...base, toolCalls: undefined } as unknown as RunReportModel,
      ])
    ).toThrow('报告值必须是数字、文字或 null')
    const html = labReports.renderRunReportHtml([
      { ...base, journeyTitle: 'NaN undefined', toolCalls: 0, costUsd: null },
    ])
    assertSelfContainedReport(html)
    expect(html).toContain('NaN undefined')
    expect(html).toContain('data-value="0">0</span>')
    expect(html).toContain('data-value="null">—</span>')
  })
})
