import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { archive } from '../spec/support.js'
import type { PromoteRealTaskCaseInput, RealTaskAssessment } from '../src/index.js'
import {
  labArchives,
  labReports,
  labWire,
  RealTaskPrivacyClassifications,
  realTaskWorkload,
} from '../src/index.js'
import { findExternalResourceViolations } from '../src/utils/render/html.js'

function record() {
  return labWire.parseRealTaskRecord({
    schema: 'agent-lab/real-task@1',
    id: 'task-1',
    capturedAt: 20,
    task: {
      sessionId: 'session-1',
      runId: 'run-1',
      rootInputId: 'message-1',
      source: 'user',
      surface: 'project',
      title: 'Fix a real persistence bug',
      prompt: 'Fix the persistence bug and run the existing checks.',
      workspaceRoot: '/private/worktree',
      startedAt: 10,
      finishedAt: 20,
      terminalStatus: 'ok',
    },
    executor: {
      executorId: 'velar-internal',
      provider: 'provider-a',
      model: 'model-a',
      reasoningProfile: 'high',
    },
    privacy: {
      classification: 'local-only',
      containsPrompt: true,
      containsAnswer: false,
      containsPaths: true,
    },
    evidence: {
      spans: [
        {
          id: 'tool-1',
          category: 'tool',
          status: 'error',
          name: 'project_edit',
          startedAt: 11,
          endedAt: 12,
          toolCallId: 'call-1',
          toolName: 'project_edit',
          toolCategoryId: 'project-changes',
          toolEffectKind: 'write',
          errorCode: 'conflict',
          provider: null,
          model: null,
          mutation: true,
          metrics: {
            latencyMs: 1,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
          },
        },
        {
          id: 'tool-2',
          category: 'tool',
          status: 'error',
          name: 'project_edit',
          startedAt: 13,
          endedAt: 14,
          toolCallId: 'call-2',
          toolName: 'project_edit',
          toolCategoryId: 'project-changes',
          toolEffectKind: 'write',
          errorCode: 'conflict',
          provider: null,
          model: null,
          mutation: true,
          metrics: {
            latencyMs: 1,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
          },
        },
        {
          id: 'tool-3',
          category: 'tool',
          status: 'error',
          name: 'project_edit',
          startedAt: 15,
          endedAt: 16,
          toolCallId: 'call-3',
          toolName: 'project_edit',
          toolCategoryId: 'project-changes',
          toolEffectKind: 'write',
          errorCode: 'conflict',
          provider: null,
          model: null,
          mutation: true,
          metrics: {
            latencyMs: 1,
            tokensIn: null,
            tokensOut: null,
            costUsd: null,
          },
        },
      ],
      assertions: [],
      artifacts: [],
      finalAnswer: null,
      userFeedback: null,
      observationGaps: [],
    },
  })
}

describe('real-task archive outcomes', () => {
  test('classifies pass, verifier failure, and attrition from the archive itself', () => {
    expect(realTaskWorkload.classifyArchiveOutcome(archive())).toEqual({
      outcome: 'pass',
      detail: '执行门与外部真相门全部通过',
    })
    expect(realTaskWorkload.classifyArchiveOutcome(archive({ score: 0 }))).toEqual({
      outcome: 'fail',
      detail: 'complete: failed',
    })
    expect(
      realTaskWorkload.classifyArchiveOutcome(
        archive({
          score: null,
          drops: [
            {
              trialId: 'trial-1',
              legId: 'leg-1',
              cause: 'environment-drift',
              detail: 'fixture changed',
            },
          ],
        })
      )
    ).toEqual({
      outcome: 'void',
      detail: 'environment-drift: fixture changed',
    })
  })

  test('keeps an archive without a conclusive leg out of the pass denominator', () => {
    const incomplete = archive()
    const result = realTaskWorkload.classifyArchiveOutcome({ ...incomplete, legs: [] })
    expect(result.outcome).toBe('void')
    expect(result.detail.length).toBeGreaterThan(0)
  })
})

describe('real workload evaluation', () => {
  test('keeps task outcome unknown while reporting broken repeated tool errors', () => {
    const input = record()
    const assessment = realTaskWorkload.audit(input, { generatedAt: 30 })
    expect(assessment.outcome).toBe('unknown')
    expect(assessment.health).toBe('broken')
    expect(assessment.verdict).toBe('needs-review')
    expect(assessment.metrics.repeatedToolErrors).toBe(3)
    expect(assessment.metrics.redundantToolCalls).toBe(0)
    expect(assessment.promotionRecommended).toBeTrue()
    const report = labReports.renderRealTaskReportHtml(assessment)
    expect(report).not.toContain(input.task.prompt!)
    expect(report).not.toContain(input.task.workspaceRoot!)
    expect(report).toContain('data-value="null">—</span>')
    expect(report).toContain('data-value="0">0</span>')
    expect(findExternalResourceViolations(report)).toEqual([])
  })

  test('renders only closed summaries while preserving private record and finding facts in every bundle classification', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-lab-private-report-'))
    try {
      for (const classification of RealTaskPrivacyClassifications) {
        const sentinels: string[] = []
        const secret = (label: string) => {
          const value = `PRIVATE-${label}-界`
          sentinels.push(value)
          return value
        }
        const base = record()
        const input = labWire.parseRealTaskRecord({
          ...base,
          id: secret('record-id'),
          capturedAt: 40,
          task: {
            ...base.task,
            sessionId: secret('session-id'),
            runId: secret('run-id'),
            rootInputId: secret('input-id'),
            surface: secret('surface'),
            title: `C:\\Private\\${secret('title')}.txt`,
            prompt: secret('prompt'),
            workspaceRoot: `/srv/private/${secret('workspace')}`,
          },
          executor: {
            executorId: secret('executor-id'),
            provider: secret('provider'),
            model: secret('model'),
            reasoningProfile: secret('reasoning-profile'),
          },
          privacy: {
            classification,
            containsPrompt: true,
            containsAnswer: true,
            containsPaths: true,
          },
          evidence: {
            spans: [
              {
                ...base.evidence.spans[0]!,
                id: secret('model-span-id'),
                category: 'model',
                status: 'ok',
                name: secret('model-span-name'),
                startedAt: 10,
                endedAt: 11,
                toolCallId: null,
                toolName: null,
                toolCategoryId: null,
                toolEffectKind: null,
                errorCode: null,
                provider: secret('span-provider'),
                model: secret('span-model'),
                mutation: false,
                metrics: { latencyMs: 1, tokensIn: 11, tokensOut: 7, costUsd: 0.01 },
              },
              ...base.evidence.spans.map((span, index) => ({
                ...span,
                id: secret(`tool-span-${index}`),
                name: secret(`span-name-${index}`),
                toolCallId: secret(`call-${index}`),
                toolName: 'PRIVATE-tool-name-界',
                errorCode: 'PRIVATE-error-code-界',
                toolCategoryId: secret(`category-${index}`),
                toolEffectKind: secret(`effect-${index}`),
              })),
            ],
            assertions: [
              {
                id: secret('assertion-id'),
                kind: 'file',
                outcome: 'fail',
                description: secret('assertion-description'),
                detail: secret('assertion-detail'),
                evidenceRefs: [secret('assertion-evidence')],
              },
              {
                id: secret('unknown-assertion-id'),
                kind: 'file',
                outcome: 'unknown',
                description: secret('unknown-description'),
                detail: secret('unknown-detail'),
                evidenceRefs: [],
              },
            ],
            artifacts: [
              {
                id: secret('artifact-id'),
                kind: secret('artifact-kind'),
                path: `/srv/private/${secret('artifact-path')}`,
                sha256: 'f'.repeat(64),
                sizeBytes: 13,
                provenance: 'agent',
              },
            ],
            finalAnswer: secret('answer'),
            userFeedback: { verdict: 'rejected', detail: secret('feedback'), recordedAt: 30 },
            observationGaps: [secret('observation-gap')],
          },
        })
        sentinels.push('PRIVATE-tool-name-界', 'PRIVATE-error-code-界', 'f'.repeat(64))
        const audited = realTaskWorkload.audit(input, { generatedAt: 40 })
        expect(
          audited.findings.some((finding) => finding.detail.includes('PRIVATE-tool-name-界'))
        ).toBe(true)
        expect(
          audited.findings.some((finding) => finding.id.includes('PRIVATE-error-code-界'))
        ).toBe(true)
        const custom = {
          id: secret('custom-finding-id'),
          severity: 'warn',
          class: 'policy',
          title: secret('custom-title'),
          detail: secret('custom-detail'),
          evidenceRefs: [secret('custom-evidence')],
        }
        const assessment = labWire.parseRealTaskAssessment({
          ...audited,
          findings: [...audited.findings, custom, { ...custom, id: secret('second-custom-id') }],
        })
        const originals = structuredClone({ input, assessment })
        const html = labReports.renderRealTaskReportHtml(assessment)
        for (const sentinel of sentinels) expect(html).not.toContain(sentinel)
        expect(html).not.toContain('/srv/private/')
        expect(html).not.toContain('C:\\Private\\')
        expect(html).toContain('verified-fail')
        expect(html).toContain('>fail</span>')
        expect(html).toContain('>broken</span>')
        for (const [label, value] of [
          ['模型调用', 1],
          ['工具调用', 3],
          ['工具错误', 3],
          ['重复错误', 3],
          ['并行冗余调用', 0],
          ['输入 token', 11],
          ['输出 token', 7],
        ])
          expect(html).toContain(
            `<span>${label}</span><strong><span data-value="${value}">${value}</span>`
          )
        const groups = [
          { category: 'tool-error', severity: 'warn', count: 1 },
          { category: 'retry-loop', severity: 'fail', count: 1 },
          { category: 'acceptance', severity: 'fail', count: 1 },
          { category: 'observation-gap', severity: 'info', count: 2 },
          { category: 'user-rejected', severity: 'fail', count: 1 },
          { category: 'policy', severity: 'warn', count: 2 },
        ]
        let summarized = 0
        for (const { category, severity, count: expected } of groups) {
          const group = html.match(
            new RegExp(
              `data-finding-class="${category}" data-finding-severity="${severity}"[\\s\\S]*?<span data-value="([0-9]+)">`
            )
          )
          expect(group).not.toBeNull()
          const count = Number(group![1])
          expect(count).toBe(expected)
          summarized += count
        }
        expect(summarized).toBe(assessment.findings.length)
        expect(html.match(/<article class="finding /g)).toHaveLength(groups.length)
        expect(findExternalResourceViolations(html)).toEqual([])
        const written = await labArchives.writeRealTaskBundle(
          join(root, classification),
          input,
          assessment
        )
        const savedRecord = JSON.parse(await readFile(written.record, 'utf8'))
        const savedAssessment = JSON.parse(await readFile(written.assessment, 'utf8'))
        expect(savedRecord).toEqual(originals.input)
        expect(savedAssessment).toEqual(originals.assessment)
        for (const sentinel of sentinels)
          expect(JSON.stringify([savedRecord, savedAssessment])).toContain(sentinel)
        expect(await readFile(written.report, 'utf8')).toBe(html)
        expect({ input, assessment }).toEqual(originals)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('rejects malformed public assessment states instead of rendering arbitrary enum or metric text', () => {
    const assessment = realTaskWorkload.audit(record(), { generatedAt: 30 })
    for (const input of [
      { ...assessment, outcome: 'PRIVATE-invalid-outcome' },
      { ...assessment, metrics: { ...assessment.metrics, modelCalls: 'PRIVATE-invalid-count' } },
      { ...assessment, findings: [{ ...assessment.findings[0]!, class: 'PRIVATE-invalid-class' }] },
    ])
      expect(() =>
        labReports.renderRealTaskReportHtml(input as unknown as RealTaskAssessment)
      ).toThrow()
  })

  test('rejects an unrelated assessment before publishing any private bundle files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-lab-report-association-'))
    try {
      const input = record()
      const assessment = realTaskWorkload.audit(input, { generatedAt: 30 })
      await assert.rejects(
        labArchives.writeRealTaskBundle(root, input, { ...assessment, recordId: 'another-record' }),
        /不属于/
      )
      expect(await readdir(root)).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('does not call parallel fan-out a feedback retry loop', () => {
    const base = record()
    const input = labWire.parseRealTaskRecord({
      ...base,
      evidence: {
        ...base.evidence,
        spans: base.evidence.spans.map((span, index) => ({
          ...span,
          startedAt: 11 + index,
          endedAt: 20,
        })),
      },
    })
    const assessment = realTaskWorkload.audit(input, { generatedAt: 30 })
    expect(assessment.metrics.repeatedToolErrors).toBe(0)
    expect(assessment.metrics.redundantToolCalls).toBe(3)
    expect(assessment.findings.some((finding) => finding.class === 'retry-loop')).toBeFalse()
    expect(assessment.findings.some((finding) => finding.class === 'redundant-call')).toBeTrue()
  })

  test('requires reviewed acceptance gates across promotion, parsing and real case files', async () => {
    const input = record()
    const options: PromoteRealTaskCaseInput = {
      id: 'case-1',
      workspace: {
        adapter: 'git',
        parameters: { sourcePath: '/private/source' },
        reference: 'abc123',
        digest: null,
      },
      coverage: {
        capability: 'project.persistence',
        objective: 'repair persisted state without corrupting unrelated records',
        archetype: 'recover',
        dataShapes: ['structured'],
        risk: 'reversible-write',
        lifecycle: 'multi-step',
        path: 'failure-recovery',
        interaction: 'autonomous',
        modelRequirement: 'text',
        dailyWeight: 1,
      },
      acceptance: [
        {
          id: 'tests',
          kind: 'command',
          description: 'existing checks pass',
          parameters: { argv: ['bun', 'test'] },
          gate: true,
        },
        {
          id: 'diagnostic',
          kind: 'command',
          description: 'collect diagnostics',
          parameters: { argv: ['bun', '--version'] },
          gate: false,
        },
      ],
      privacy: { classification: 'redacted', reviewNote: 'reviewed' },
      createdAt: 40,
    }
    const promoted = realTaskWorkload.promoteCase(input, options)
    expect(promoted.origin).toEqual({ kind: 'observed', recordId: input.id })
    expect(labWire.parseRealTaskCase(promoted)).toEqual(promoted)
    expect(labWire.parseAcceptanceContract(options.acceptance[1]).gate).toBe(false)

    const root = await mkdtemp(join(tmpdir(), 'agent-lab-case-gates-'))
    try {
      const invalidPlans = [
        [],
        options.acceptance.map((contract) => ({ ...contract, gate: false })),
      ]
      for (const [index, acceptance] of invalidPlans.entries()) {
        expect(() => realTaskWorkload.promoteCase(input, { ...options, acceptance })).toThrow(
          '验收门'
        )
        const invalid = { ...promoted, acceptance }
        expect(() => labWire.parseRealTaskCase(invalid)).toThrow('验收门')
        const existing = await readdir(root)
        await assert.rejects(
          labArchives.writeRealTaskCase(join(root, 'published.json'), invalid),
          /验收门/
        )
        expect(await readdir(root)).toEqual(existing)
        const source = join(root, `invalid-${index}.json`)
        const bytes = JSON.stringify(invalid)
        await writeFile(source, bytes)
        await assert.rejects(labArchives.readRealTaskCase(source), /验收门/)
        expect(await readFile(source, 'utf8')).toBe(bytes)
      }
      const path = await labArchives.writeRealTaskCase(join(root, 'valid.json'), promoted)
      expect(await labArchives.readRealTaskCase(path)).toEqual(promoted)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('keeps unrun and void work in the verified coverage denominator', () => {
    const base = realTaskWorkload.promoteCase(record(), {
      id: 'case-coverage-a',
      workspace: {
        adapter: 'manual',
        parameters: { sourcePath: '/private/source' },
        reference: 'snapshot-v1',
        digest: null,
      },
      coverage: {
        capability: 'system.files',
        objective: 'read a bounded log window',
        archetype: 'inspect',
        dataShapes: ['text'],
        risk: 'read-only',
        lifecycle: 'single-turn',
        path: 'happy',
        interaction: 'autonomous',
        modelRequirement: 'text',
        dailyWeight: 3,
      },
      acceptance: [
        {
          id: 'tests',
          kind: 'command',
          description: 'checks pass',
          parameters: { argv: ['bun', 'test'] },
          gate: true,
        },
      ],
      privacy: { classification: 'redacted', reviewNote: 'reviewed' },
    })
    const second = {
      ...base,
      id: 'case-coverage-b',
      coverage: { ...base.coverage, objective: 'recover a failed edit', dailyWeight: 1 },
    }
    const third = {
      ...base,
      id: 'case-coverage-c',
      coverage: { ...base.coverage, objective: 'inspect a binary boundary', dailyWeight: 1 },
    }
    const [summary] = realTaskWorkload.summarizeCoverage(
      [base, second, third],
      [
        { caseId: base.id, outcome: 'pass' },
        { caseId: second.id, outcome: 'void' },
      ]
    )
    expect(summary?.verifiedCoverage).toBe(0.6)
    expect(summary?.conclusivePassRate).toBe(1)
    expect(summary?.voided).toBe(1)
    expect(summary?.notRun).toBe(1)
  })
})
