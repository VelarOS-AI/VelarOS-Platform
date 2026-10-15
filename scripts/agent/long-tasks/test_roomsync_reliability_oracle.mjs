// 前瞻长程验收：完整真实副作用和独立预期仍需审计源程序及宿主执行证据。
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { runCapturedCommand } from './command-output.mjs'
import { readReliabilityEvidence } from './reliability-evidence.mjs'
import './test_roomsync_reliability.mjs'

test('prospective long campaign reconciles complete work intervals', async () => {
  const result = await readReliabilityEvidence(resolve('contrib/roomsync/reliability'), {
    workIntervals: true,
  })
  assert.equal(result.intervalAccounting.structuralTimeVerified, true)
  assert.equal(result.productiveTimeVerified, false)
})

test(
  'short verifier detects actual acknowledged store mutations for put delete and patch',
  { timeout: 150000 },
  async () => {
    // 评分副本独占保存完整原始诊断，资源归档器统一留存和回收。
    const output = await mkdtemp(resolve('.reliability-oracle-'))
    const preload = fileURLToPath(new URL('./roomsync-store-mutation.cjs', import.meta.url))
    const script = resolve('contrib/roomsync/test/reliability-soak.js')
    const results = []
    for (const kind of ['none', 'put', 'delete', 'patch']) {
      const mutationLog = join(output, `${kind}-mutations.jsonl`)
      const result = await runCapturedCommand(
        process.execPath,
        [
          script,
          '--directory',
          join(output, kind),
          '--duration-ms',
          '3500',
          '--fault-interval-ms',
          '500',
        ],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            ...(kind === 'none'
              ? {}
              : {
                  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(preload)}`,
                  VELAR_EVAL_PROJECT: process.cwd(),
                  VELAR_EVAL_MUTATION: kind,
                  VELAR_EVAL_MUTATION_LOG: mutationLog,
                }),
          },
          timeout: 30000,
        }
      )
      await writeFile(join(output, `${kind}-run.json`), JSON.stringify(result, null, 2))
      assert.equal(result.timedOut, false, 'Timeout does not establish invariant detection')
      if (kind === 'none') {
        assert.equal(result.exitCode, 0, JSON.stringify(result))
        await readReliabilityEvidence(join(output, kind), {
          productiveMs: 3500,
          transactions: 5,
          faults: 1,
          workIntervals: true,
        })
        results.push({ kind, exitCode: result.exitCode })
        continue
      }
      const text = await readFile(mutationLog, 'utf8')
      const mutations = text.trim().split('\n').map(JSON.parse)
      assert(mutations.length > 0, `No acknowledged ${kind} mutation; coverage is missing`)
      for (const mutation of mutations) {
        assert.equal(mutation.receipt.requestId, mutation.original.requestId)
        assert.equal(mutation.receipt.clientId, mutation.original.clientId)
        assert.notDeepEqual(mutation.original.operations, mutation.committed.operations)
      }
      assert.notEqual(result.exitCode, 0, `${kind} mutation was acknowledged but accepted`)
      results.push({
        kind,
        exitCode: result.exitCode,
        acknowledgedMutations: mutations.length,
        mutationLog,
        semanticMutationVerified: false,
      })
    }
    // 成功回执和不同操作是机械门槛；实际错误状态及其被拒绝原因另作对称独立审计。
    const report = { results, requiresIndependentSemanticAudit: true }
    await writeFile(join(output, 'result.json'), JSON.stringify(report, null, 2))
    console.log(JSON.stringify({ oracleEvidence: output, ...report }))
  }
)
