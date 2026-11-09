import { describe, expect, test } from 'bun:test'

import { archive, FullCapabilities, journey } from '../spec/support.js'
import {
  labCertification,
  labReports,
  labStatistics,
  labWire,
  ObservationFaces,
  realTaskWorkload,
} from '../src/index.js'

describe('statistics and certification', () => {
  test('strictly validates public certification inputs', () => {
    expect(
      labWire.parseCertificationSubject({
        kind: 'mod',
        id: 'example-mod',
        version: '1.0.0',
        digest: 'a'.repeat(64),
      }).id
    ).toBe('example-mod')
    expect(() =>
      labWire.parseCertificationPolicy({
        id: 'policy',
        version: 1,
        requiredJourneyIds: ['journey-a'],
        minimumReplicatesPerJourney: 3,
        minimumReliability: 1.5,
        maximumAttritionRate: 0.05,
        requiredObservationCoverage: { transcript: 'full' },
        requireSeparateVerifier: true,
        requireNativeExecution: true,
        requireBaseline: false,
        maximumBaselineRegression: 0.02,
      })
    ).toThrow()
  })
  test('uses paired journey clusters and refuses false precision with one cluster', () => {
    const oneCluster = [
      archive({ executorId: 'a', journeyId: 'j1', groupId: 'g1', score: 1 }),
      archive({ executorId: 'b', journeyId: 'j1', groupId: 'g1', score: 0 }),
    ]
    const one = labStatistics.compareExecutors(oneCluster, 'a', 'b')
    expect(one.completionDifference.estimate).toBe(1)
    expect(one.completionDifference.lower95).toBeNull()
    expect(one.decision).toBe('inconclusive')

    const two = labStatistics.compareExecutors(
      [
        ...oneCluster,
        archive({ executorId: 'a', journeyId: 'j2', groupId: 'g2', score: 1 }),
        archive({ executorId: 'b', journeyId: 'j2', groupId: 'g2', score: 0 }),
      ],
      'a',
      'b',
      { bootstrapSamples: 500, seed: 7 }
    )
    expect(two.clusters).toBe(2)
    expect(two.decision).toBe('a-better')
  })

  test('separates attrition from reliability denominator and enforces comparability', () => {
    const dropped = archive({
      runId: 'dropped',
      drops: [
        {
          trialId: 't',
          legId: null,
          cause: 'environment-drift',
          detail: 'changed',
        },
      ],
    })
    const reliability = labStatistics.estimateReliability([archive(), dropped])
    expect(reliability.attempts).toBe(1)
    expect(reliability.dropped).toBe(1)
    const original = archive({ runId: 'drifted' })
    const drifted = {
      ...original,
      manifest: {
        ...original.manifest,
        budget: { ...original.manifest.budget, tokens: 99 },
      },
    }
    expect(labStatistics.checkComparability([archive(), drifted]).comparable).toBeFalse()
  })

  test('rejects duplicate run ids before statistics or certification counts and preserves distinct reruns', () => {
    const original = archive()
    const copied = labWire.parseRunArchive(JSON.parse(JSON.stringify(original)))
    const policy = {
      id: 'unique-evidence',
      version: 1,
      requiredJourneyIds: ['journey-a'],
      minimumReplicatesPerJourney: 2,
      minimumReliability: 0,
      maximumAttritionRate: 0,
      requiredObservationCoverage: {},
      requireSeparateVerifier: true,
      requireNativeExecution: true,
      requireBaseline: false,
      maximumBaselineRegression: 0,
    }
    const certification = {
      subject: { kind: 'agent' as const, id: 'a', version: '1', digest: 'digest' },
      policy,
      subjectExecutorId: 'executor-a',
      now: () => 1,
    }
    for (const duplicate of [original, copied]) {
      const archives = [original, duplicate]
      const message = `重复的 runId: ${original.manifest.runId}`
      expect(() => labStatistics.estimateReliability(archives)).toThrow(message)
      expect(() => labStatistics.failureDistribution(archives)).toThrow(message)
      expect(() => labStatistics.checkComparability(archives)).toThrow(message)
      expect(() => labStatistics.compareExecutors(archives, 'executor-a', 'executor-b')).toThrow(
        message
      )
      expect(() => labCertification.certify({ ...certification, archives })).toThrow(message)
      expect(() =>
        labCertification.certify({
          ...certification,
          archives: [original],
          baselineArchives: [duplicate],
        })
      ).toThrow(message)
    }
    const reruns = [original, archive({ runId: 'independent-rerun' })]
    expect(labStatistics.estimateReliability(reruns)).toMatchObject({ attempts: 2, successes: 2 })
    expect(labCertification.certify({ ...certification, archives: reruns }).status).toBe(
      'certified'
    )
  })

  test('reports ambiguous executor pair keys as not comparable without selecting the last run', () => {
    const a = archive({ executorId: 'a', score: 1 })
    const b = archive({ executorId: 'b', score: 0 })
    for (const executorId of ['a', 'b']) {
      const rerun = archive({ executorId, runId: `${executorId}-rerun`, score: 0.5 })
      for (const archives of [
        [a, b, rerun],
        [rerun, b, a],
      ]) {
        const comparison = labStatistics.compareExecutors(archives, 'a', 'b')
        expect(comparison.decision).toBe('not-comparable')
        expect(comparison.comparability.reasons).toContain(
          `${executorId}: 同一配对键对应多次运行，无法唯一配对`
        )
        expect(comparison.matchedPairs).toBe(0)
        expect(comparison.completionDifference.estimate).toBeNull()
      }
    }
    const replicated = labStatistics.compareExecutors(
      [
        a,
        b,
        archive({ executorId: 'a', replicateIndex: 2, score: 1 }),
        archive({ executorId: 'b', replicateIndex: 2, score: 0 }),
      ],
      'a',
      'b'
    )
    expect(replicated.comparability.comparable).toBe(true)
    expect(replicated.matchedPairs).toBe(2)
    expect(replicated.completionDifference.estimate).toBe(1)
  })

  test('requires complete unique declared leg coverage before reporting or counting a journey pass', () => {
    const definition = journey('journey-a', 2)
    const base = archive({ executorId: 'a' })
    const first = base.legs[0]!
    const full = labWire.parseRunArchive({
      ...base,
      manifest: {
        ...base.manifest,
        budget: definition.budget,
        usage: { ...base.manifest.usage, legs: 2 },
      },
      journey: definition,
      legs: [first, { ...first, legId: 'leg-2' }],
    })
    const other = archive({ executorId: 'b' })
    const reference = labWire.parseRunArchive({
      ...full,
      manifest: {
        ...other.manifest,
        budget: definition.budget,
        usage: { ...other.manifest.usage, legs: 2 },
      },
    })
    expect(realTaskWorkload.classifyArchiveOutcome(full).outcome).toBe('pass')
    expect(labStatistics.estimateReliability([full])).toMatchObject({
      attempts: 1,
      successes: 1,
      dropped: 0,
    })
    expect(labReports.createRunReportModel(full)).toMatchObject({
      passedLegs: 2,
      totalLegs: 2,
      completion: 1,
    })

    for (const legs of [[first], [first, first], [first, { ...first, legId: 'foreign-leg' }], []]) {
      // 这些均是当前 schema 接受的原始数据；完整旅程结论还必须核对声明身份。
      const incomplete = labWire.parseRunArchive({ ...full, legs })
      expect(realTaskWorkload.classifyArchiveOutcome(incomplete).outcome).toBe('void')
      expect(labStatistics.estimateReliability([incomplete])).toMatchObject({
        attempts: 0,
        successes: 0,
        dropped: 1,
      })
      const report = labReports.createRunReportModel(incomplete)
      expect(report.completion).toBeNull()
      expect(report.passedLegs).toBeNull()
      expect(report.totalLegs).toBe(2)
      expect(report.verdicts.some((verdict) => verdict.id === 'all-gates-green')).toBe(false)
      expect(report.verdicts.some((verdict) => verdict.id === 'journey-incomplete')).toBe(true)
      const comparison = labStatistics.compareExecutors([incomplete, reference], 'a', 'b')
      expect(comparison.matchedPairs).toBe(0)
      expect(comparison.completionDifference.estimate).toBeNull()
      expect(comparison.attrition.a).toBe(1)
    }

    const failure = archive({ executorId: 'a', score: 0 })
    const failedPrefix = labWire.parseRunArchive({ ...full, legs: failure.legs })
    expect(realTaskWorkload.classifyArchiveOutcome(failedPrefix).outcome).toBe('fail')
    expect(labStatistics.estimateReliability([failedPrefix])).toMatchObject({
      attempts: 1,
      successes: 0,
      dropped: 0,
    })
    expect(labReports.createRunReportModel(failedPrefix).legs[0]!.passed).toBe(false)
  })

  test('uses the same completion for reports and paired statistics without replacing unknown or attrition by zero', () => {
    const base = archive({ executorId: 'a' })
    const leg = base.legs[0]!
    const partial = labWire.parseRunArchive({
      ...base,
      legs: [
        {
          ...leg,
          score: 0.5,
          passed: false,
          criteria: [
            {
              ...leg.criteria[0]!,
              outcome: {
                kind: 'partial',
                credit: 0.5,
                reason: 'Partial gate credit',
                evidence: {},
              },
            },
          ],
        },
      ],
    })
    const reference = archive({ executorId: 'b', score: 0 })
    expect(labReports.createRunReportModel(partial).completion).toBe(0.5)
    expect(
      labStatistics.compareExecutors([partial, reference], 'a', 'b').completionDifference.estimate
    ).toBe(0.5)
    const dropped = labWire.parseRunArchive({
      ...partial,
      drops: [
        {
          trialId: partial.manifest.trial.id,
          legId: 'leg-1',
          cause: 'environment-drift',
          detail: 'Fixture changed',
        },
      ],
    })
    const unknown = archive({ executorId: 'a', score: null })
    for (const value of [dropped, unknown]) {
      const report = labReports.createRunReportModel(value)
      expect(report.completion).toBeNull()
      expect(report.legs[0]!.score).toBe(value.legs[0]!.score)
      expect(realTaskWorkload.classifyArchiveOutcome(value).outcome).toBe('void')
      expect(labStatistics.estimateReliability([value])).toMatchObject({
        attempts: 0,
        successes: 0,
        dropped: 1,
      })
      const comparison = labStatistics.compareExecutors([value, reference], 'a', 'b')
      expect(comparison.matchedPairs).toBe(0)
      expect(comparison.completionDifference.estimate).toBeNull()
    }
  })

  test('certifies only observed evidence and marks missing faces inconclusive', () => {
    const policy = {
      id: 'policy',
      version: 1,
      requiredJourneyIds: ['journey-a'],
      minimumReplicatesPerJourney: 1,
      minimumReliability: 0,
      maximumAttritionRate: 0,
      requiredObservationCoverage: { artifacts: 'full' as const },
      requireSeparateVerifier: true,
      requireNativeExecution: true,
      requireBaseline: false,
      maximumBaselineRegression: 0.05,
    }
    const subject = {
      kind: 'agent' as const,
      id: 'a',
      version: '1',
      digest: 'digest',
    }
    expect(
      labCertification.certify({
        subject,
        policy,
        archives: [archive()],
        subjectExecutorId: 'executor-a',
        now: () => 1,
      }).status
    ).toBe('certified')

    const noArtifacts = {
      ...FullCapabilities,
      observes: Object.fromEntries(
        ObservationFaces.map((face) => [face, face === 'artifacts' ? 'none' : 'full'])
      ) as typeof FullCapabilities.observes,
    }
    expect(
      labCertification.certify({
        subject,
        policy,
        archives: [archive({ capabilities: noArtifacts })],
        subjectExecutorId: 'executor-a',
        now: () => 1,
      }).status
    ).toBe('inconclusive')
  })
})
