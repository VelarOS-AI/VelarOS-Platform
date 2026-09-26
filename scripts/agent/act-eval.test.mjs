import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { labArchives } from '@velaros-ai/agent-lab'
import { runActEvaluation } from './act-eval.mjs'
import { configuredModel } from './run-act-eval.mjs'
import { evaluationScenario } from './act-scenarios.mjs'
import { runActEvaluationBatch } from './act-eval-batch.mjs'

const limits = { contextTokens: 200000, inputTokens: 180000, outputTokens: 4096 }
/** 本帧会变的协议与阶段说明在最后一条消息末尾（系统提示在会话内不变）。 */
const frameText = (request) => request.compiledPrompt ?? ''
const marker = (request) => frameText(request).match(/当前帧标记：(\S+)。普通/u)[1]
const block = (request, kind, source) =>
  `${marker(request)} ${kind}()\n${source}\n${marker(request)}`
const model = (stream) => ({
  id: 'controlled-model',
  limits,
  estimate: async () => ({
    tokens: 1000,
    precision: 'exact',
    basis: 'controlled fixture, not provider tokens',
  }),
  stream,
})
async function output(t) {
  const directory = await mkdtemp(join(tmpdir(), 'act-eval-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return directory
}

test('batch evaluation preserves failed attempts and unknown usage in repeat statistics', async (t) => {
  let calls = 0
  const report = await runActEvaluationBatch(
    { output: await output(t), repeat: 3, scenarios: ['read-edit-observe'] },
    async () => {
      if (++calls === 2) throw Error('transport failed')
      return {
        summary: { passed: true, wallClockMs: calls * 10, totalUsage: { totalTokens: 100 } },
      }
    }
  )
  assert.equal(calls, 3)
  assert.equal(report.passed, false)
  assert.deepEqual(report.groups, [
    {
      scenario: 'read-edit-observe',
      attempts: 3,
      successful: 2,
      successRate: 2 / 3,
      measuredDurations: 2,
      p50Ms: 10,
      p95Ms: 30,
      totalTokens: null,
    },
  ])
  assert.equal(
    JSON.parse(await readFile(join(report.output, 'summary.json'), 'utf8')).runs.length,
    3
  )
  await assert.rejects(runActEvaluationBatch({ output: report.output, repeat: 0 }), /重复/)
})

test('reconciliation restores host progress from acknowledged ordered revisions without rewriting inputs', async (t) => {
  const root = await output(t),
    scenario = evaluationScenario('reconciliation'),
    events = []
  await mkdir(join(root, 'orders'))
  for (const [path, text] of Object.entries(scenario.files)) await writeFile(join(root, path), text)
  for (let phase = 1; phase <= 3; phase++) {
    const rows = (
      await Promise.all(
        Object.keys(scenario.files).map(async (path) =>
          JSON.parse(await readFile(join(root, path), 'utf8'))
        )
      )
    ).flat()
    const total = rows.reduce(
      (result, item) => {
        result.count++
        if (item.status === 'approved') {
          result.totalCents += item.cents
          result.approved++
        } else result.pending++
        return result
      },
      { totalCents: 0, approved: 0, pending: 0, count: 0 }
    )
    await writeFile(join(root, `stage-${phase - 1}.json`), JSON.stringify(total))
    const request = { id: `question-${phase}`, kind: 'input', message: `revision:${phase}` }
    await scenario.answer({ root, request })
    events.push({ type: 'interaction', request }, { type: 'answer', id: request.id })
  }
  const before = await Promise.all(
    Object.keys(scenario.files).map((path) => readFile(join(root, path), 'utf8'))
  )
  await evaluationScenario('reconciliation').restore({ root, events })
  assert.deepEqual(
    await Promise.all(
      Object.keys(scenario.files).map((path) => readFile(join(root, path), 'utf8'))
    ),
    before
  )
  await assert.rejects(
    evaluationScenario('reconciliation').restore({ root, events: events.slice(2) }),
    /顺序/
  )
  await assert.rejects(
    evaluationScenario('reconciliation').restore({
      root,
      events: [{ type: 'answer', id: 'invented' }],
    }),
    /缺少/
  )
  await writeFile(join(root, 'orders/batch-1.json'), '[]')
  await assert.rejects(evaluationScenario('reconciliation').restore({ root, events }), /不一致/)
})

test('formal Runtime evaluation archives raw requests and independently verifies v1, one edit and v2', async (t) => {
  let calls = 0
  const driver = model(async function* (request) {
    calls++
    if (calls === 1)
      yield {
        type: 'text',
        text: block(
          request,
          'observe',
          "import {read} from 'velaros:project';import {output} from 'velaros';// 持续核对 state.txt 的真实内容\noutput(await read({files:[{path:'state.txt'}]}));"
        ),
      }
    else if (calls === 2) {
      assert.match(JSON.parse(request.materials[0].text).partitions.observation.text, /one/)
      yield {
        type: 'text',
        text: block(
          request,
          'execute',
          "import {read,edit} from 'velaros:project';import {output} from 'velaros';const file=(await read({files:[{path:'state.txt'}]})).files[0];if(file.text!=='one\\n')throw Error('unexpected');output(await edit({steps:[{action:'replace',path:'state.txt',oldText:'one',newText:'two'}]}));"
        ),
      }
    } else {
      assert.match(JSON.parse(request.materials[0].text).partitions.observation.text, /two/)
      yield { type: 'text', text: `${marker(request)} done` }
    }
    yield { type: 'usage', inputTokens: 100, outputTokens: 20 }
    yield { type: 'finish', reason: 'stop' }
  })
  const result = await runActEvaluation({ model: driver, output: await output(t) })
  assert.equal(result.summary.passed, true, JSON.stringify(result.archive))
  assert.equal(calls, 3)
  assert.equal(result.summary.usage.totalTokens, 360)
  assert.equal(result.summary.usage.costUsd, null)
  assert(result.summary.wallClockMs > 0)
  assert(
    result.summary.metrics.some(
      (metric) => metric.phase === 'storage' && metric.operation === 'appendRecord'
    )
  )
  assert.equal(result.summary.requestRetries, 0)
  assert.equal(result.summary.protocolRejections, 0)
  assert.equal(result.archive.legs[0].criteria[0].outcome.evidence.successfulEdits, 1)
  const traces = JSON.parse(await readFile(result.summary.tracePath, 'utf8'))
  assert((await readFile(join(result.summary.directory, 'events.ndjson'), 'utf8')).includes('turn'))
  assert.equal(traces.length, 3)
  assert(traces.every((trace) => trace.gaps.length === 0))
  assert(
    traces.every((trace) =>
      Object.values(trace.timing).every((value) => typeof value === 'number' && value >= 0)
    )
  )
  assert(JSON.parse(traces[2].request.body).providerRequest)
  assert((await labArchives.readRunArchive(result.summary.archivePath)).archive)
})

test('done without the actual change fails external verification and unknown usage stays null', async (t) => {
  const result = await runActEvaluation({
    model: model(async function* (request) {
      yield { type: 'text', text: `${marker(request)} done` }
      yield { type: 'finish', reason: 'stop' }
    }),
    output: await output(t),
  })
  assert.equal(result.summary.passed, false)
  assert.equal(result.summary.usage.totalTokens, null)
  assert.equal(result.archive.legs[0].criteria[0].outcome.kind, 'fail')
  assert.equal(await readFile(join(result.summary.directory, 'project/state.txt'), 'utf8'), 'one\n')
})

test('an unclosed execution block never edits disk and rejection evidence is archived', async (t) => {
  const result = await runActEvaluation({
    model: model(async function* (request) {
      yield { type: 'text', text: `${marker(request)} execute()\nthrow Error('partial');` }
      yield { type: 'finish', reason: 'length' }
    }),
    output: await output(t),
  })
  assert.equal(result.summary.passed, false)
  assert.equal(result.summary.modelCalls, 1)
  assert(result.traces.every((trace) => JSON.parse(trace.decision.body).status === 'rejected'))
  assert.equal(result.archive.legs[0].criteria[0].outcome.evidence.editCalls, 0)
})

test('a stalled model ends at the formal Runtime deadline and leaves a failed archive', async (t) => {
  const started = Date.now()
  const result = await runActEvaluation({
    model: model(async function* () {
      await new Promise(() => {})
    }),
    output: await output(t),
    timeoutMs: 150,
  })
  assert.equal(result.summary.passed, false)
  assert(Date.now() - started < 3000)
  assert.equal(result.summary.modelCalls, 1)
  assert.equal(
    (await labArchives.readRunArchive(result.summary.archivePath)).archive.legs[0].passed,
    false
  )
})

test('model configuration requires an explicit credential variable and never retains its value in metadata', () => {
  const config = {
    provider: 'openai',
    model: 'configured-model',
    baseURL: 'https://api.example.test/v1',
    apiKeyEnv: 'ACT_TEST_KEY',
    ...limits,
  }
  assert.throws(() => configuredModel(config, {}), /ACT_TEST_KEY/)
  assert.throws(() => configuredModel({ ...config, apiKey: 'secret' }, {}), /配置字段/)
  assert.throws(
    () => configuredModel({ ...config, baseURL: 'https://secret@example.test/v1' }, {}),
    /凭据/
  )
  assert.throws(() => configuredModel({ ...config, inputTokens: 200000 }, {}), /容量/)
  assert.throws(
    () =>
      configuredModel(
        { ...config, reasoningLevel: 'invented' },
        { ACT_TEST_KEY: 'private-test-value' }
      ),
    /思考力度/
  )
  const configured = configuredModel(
    { ...config, reasoningLevel: 'high' },
    { ACT_TEST_KEY: 'private-test-value' }
  )
  assert(!JSON.stringify(configured.configuration).includes('private-test-value'))
  assert.equal(configured.model.id, 'openai/configured-model')
  assert.equal(configured.configuration.reasoningLevel, 'high')
})

/** 段内历史里最近一次执行的输出值：首行是元数据，正文在「当次输出：」之后。 */
const latestOutput = (request) =>
  [...(request.history ?? [])].reverse().flatMap((message) => {
    try {
      const split = message.content.indexOf('\n')
      const row = JSON.parse(split < 0 ? message.content : message.content.slice(0, split))
      const body = split < 0 ? '' : message.content.slice(split + 1)
      const output = body.indexOf('当次输出：\n')
      row.text = output < 0 ? body : body.slice(output + '当次输出：\n'.length)
      if (row.origin !== 'runtime-execution' || !row.text) return []
      const result = JSON.parse(row.text)
      return result.result?.value?.default === undefined ? [] : [result.result.value.default]
    } catch {
      return []
    }
  })[0]
const frame = (request) =>
  JSON.parse(request.materials.find((item) => item.origin === 'runtime-view').text)

test('cooperation workload verifies the persisted child write, exact message ack and maintenance independently', async (t) => {
  let main = 0,
    child = 0
  const driver = model(async function* (request) {
    let code
    if (frameText(request).includes('你是上下文整理工具')) {
      // 整理支线分两步：先提交补丁，受理后的下一帧再完成
      if (frameText(request).includes('当前候选补丁已通过校验并受理'))
        yield { type: 'text', text: marker(request) + ' done' }
      else {
        const snapshot = JSON.parse(frame(request).partitions.task.goals[0].text).snapshot
        code = `import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify({ baseRevision: snapshot.baseRevision, summary: 'Keep the verified total and task goal', unresolved: [] })}));`
        yield { type: 'text', text: block(request, 'execute', code) }
      }
    } else if (!request.instructions.includes('velaros:agents')) {
      if (++child === 1) {
        const id = frame(request).partitions.runtime.stores.active.items[0].id
        code = `import {store} from 'velaros:system';import {read} from 'velaros:project';import {output} from 'velaros';const f=(await read({files:[{path:'orders.json'}]})).files[0];const numbers=JSON.parse(f.text);output(await store.set({store:${JSON.stringify(id)},key:'result/summary',baseRevision:0,value:{total:numbers.reduce((a,b)=>a+b,0),count:numbers.length},event:{topic:'result/ready',value:{ready:true}}}));`
        yield { type: 'text', text: block(request, 'execute', code) }
      } else yield { type: 'text', text: marker(request) + ' done' }
    } else {
      main++
      if (main === 1)
        code =
          "import {store,memory} from 'velaros:system';import {output} from 'velaros';const space=await store.create({name:'handoff',description:'Order totals and child results'});await store.subscribe({store:space.id,topics:['result/']});await memory.update({key:'progress',baseRevision:0,body:'Await child total, then verify report',sources:[]});output(space);"
      else if (main === 2) {
        const id = frame(request).partitions.runtime.stores.active.items[0].id
        code = `import {start,wait} from 'velaros:agents';import {output} from 'velaros';const job=await start({task:'Read orders and write total to result/summary with event result/ready',profile:'worker',stores:[{store:${JSON.stringify(id)},read:[''],write:['result/']}]});output(await wait({id:job.id}));`
      } else if (main === 3) {
        const id = frame(request).partitions.runtime.stores.active.items[0].id
        code = `import {store,memory} from 'velaros:system';import {output} from 'velaros';const page=await store.events({store:${JSON.stringify(id)}});if(!page)throw Error('subscription missing');await store.ack({store:${JSON.stringify(id)},ids:page.events.map(event=>event.id)});output(await store.events({store:${JSON.stringify(id)}}));output(await memory.organize({focus:'Keep total 50 and next report verification'}));`
      } else if (main === 4) {
        code =
          "import {edit} from 'velaros:project';import {output} from 'velaros';output(await edit({steps:[{action:'write',path:'report.json',text:JSON.stringify({total:50,count:4})+'\\n'}]}));"
        yield {
          type: 'text',
          text:
            block(
              request,
              'observe',
              "import {read} from 'velaros:project';import {output} from 'velaros';// 持续核实报告\noutput(await read({files:[{path:'report.json'}]}),{key:'report',purpose:'Verify actual report'});"
            ) + '\n',
        }
      } else yield { type: 'text', text: marker(request) + ' done' }
      if (code) yield { type: 'text', text: block(request, 'execute', code) }
    }
    yield { type: 'usage', inputTokens: 100, outputTokens: 20 }
    yield { type: 'finish', reason: 'stop' }
  })
  const result = await runActEvaluation({
    model: driver,
    output: await output(t),
    scenario: 'system-cooperation',
  })
  assert.equal(
    result.summary.passed,
    true,
    JSON.stringify({
      outcome: result.archive.legs[0].criteria[0].outcome,
      rootDecisions: result.traces.map((turn) => JSON.parse(turn.decision.body)),
      rootResults: result.traces.flatMap((turn) =>
        turn.records
          .filter((record) => record.title.endsWith(':result'))
          .map((record) => record.body)
      ),
      errors: [...result.traces, ...result.branches.flatMap((branch) => branch.turns)]
        .flatMap((turn) =>
          turn.invocations.map((value) => {
            try {
              return JSON.parse(value.body)
            } catch {
              return null
            }
          })
        )
        .filter((value) => value?.receipt?.outcome !== 'succeeded'),
      decisions: result.branches.map((branch) =>
        branch.turns.map((turn) => JSON.parse(turn.decision.body))
      ),
    })
  )
  assert(result.branches.some((branch) => branch.kind === 'agent' && branch.turns.length === 2))
  assert(result.branches.some((branch) => branch.kind === 'context' && branch.turns.length === 2))
  assert(
    result.branches.every((branch) => branch.turns.every((turn) => turn.request && turn.response))
  )
})

test('semantic search workload retains real branch evidence and verifies the fixed function at its boundary', async (t) => {
  let main = 0,
    search = 0
  const driver = model(async function* (request) {
    if (frameText(request).includes('你正在执行有界搜索')) {
      if (++search === 1)
        yield {
          type: 'text',
          text: block(
            request,
            'execute',
            "import {read} from 'velaros:evidence';import {output} from 'velaros';output(await read({target:{kind:'resource',sourceId:'project',resourceId:'src/session.mjs'}}));"
          ),
        }
      else {
        const evidence = latestOutput(request)
        assert(evidence?.id)
        yield {
          type: 'text',
          text:
            block(
              request,
              'execute',
              `import {output} from 'velaros';import {report} from 'velaros:evidence';await report({findings:[{text:'Expiry boundary uses an inclusive comparison',evidenceIds:[${JSON.stringify(evidence.id)}]}],gaps:[],nextSteps:['Use exclusive expiry']});`
            ) +
            '\n' +
            marker(request) +
            ' done',
        }
      }
    } else {
      main++
      if (main === 1)
        yield {
          type: 'text',
          text: block(
            request,
            'execute',
            "import {search} from 'velaros:search';import {output} from 'velaros';output(await search({query:'session expiry'}));"
          ),
        }
      else if (main === 2) {
        const report = latestOutput(request)
        assert(report?.ref)
        yield {
          type: 'text',
          text: block(
            request,
            'execute',
            `import {read as refresh} from 'velaros:search';import {read,edit} from 'velaros:project';import {output} from 'velaros';output(await refresh({ref:${JSON.stringify(report.ref)},mode:'current'}));const file=(await read({files:[{path:'src/session.mjs'}]})).files[0];if(!file.text.includes('>='))throw Error('missing');output(await edit({steps:[{action:'replace',path:'src/session.mjs',oldText:'>=',newText:'>'}]}));`
          ),
        }
      } else if (main === 3)
        yield {
          type: 'text',
          text: block(
            request,
            'observe',
            "import {read} from 'velaros:project';import {output} from 'velaros';output(await read({files:[{path:'src/session.mjs'}]}));"
          ),
        }
      else yield { type: 'text', text: marker(request) + ' done' }
    }
    yield { type: 'finish', reason: 'stop' }
  })
  const result = await runActEvaluation({
    model: driver,
    output: await output(t),
    scenario: 'semantic-search',
  })
  assert.equal(
    result.summary.passed,
    true,
    JSON.stringify({
      outcome: result.archive.legs[0].criteria[0].outcome,
      rootDecisions: result.traces.map((turn) => JSON.parse(turn.decision.body)),
      rootResults: result.traces.flatMap((turn) =>
        turn.records
          .filter((record) => record.title.endsWith(':result'))
          .map((record) => record.body)
      ),
      errors: [...result.traces, ...result.branches.flatMap((branch) => branch.turns)]
        .flatMap((turn) =>
          turn.invocations.map((value) => {
            try {
              return JSON.parse(value.body)
            } catch {
              return null
            }
          })
        )
        .filter((value) => value?.receipt?.outcome !== 'succeeded'),
      decisions: result.branches.map((branch) =>
        branch.turns.map((turn) => JSON.parse(turn.decision.body))
      ),
    })
  )
  assert.equal(search, 2)
})

for (const scenario of ['system-cooperation', 'semantic-search'])
  test(`${scenario} rejects a completion claim without evidence`, async (t) => {
    const result = await runActEvaluation({
      scenario,
      output: await output(t),
      model: model(async function* (request) {
        yield { type: 'text', text: marker(request) + ' done' }
        yield { type: 'finish', reason: 'stop' }
      }),
    })
    assert.equal(result.summary.passed, false)
    assert(
      Object.values(result.archive.legs[0].criteria[0].outcome.evidence.checks).includes(false)
    )
  })

test('reconciliation advances four actual source versions through the same child and durable store', async (t) => {
  let main = 0,
    child = 0
  const seenGoals = new Set()
  const driver = model(async function* (request) {
    const view = frame(request)
    if (frameText(request).includes('你是上下文整理工具')) {
      // 整理支线分两步：先提交补丁，受理后的下一帧再完成
      if (frameText(request).includes('当前候选补丁已通过校验并受理'))
        yield { type: 'text', text: marker(request) + ' done' }
      else {
        const snapshot = JSON.parse(view.partitions.task.goals[0].text).snapshot
        yield {
          type: 'text',
          text: block(
            request,
            'execute',
            `import {output} from 'velaros';import {submit} from 'velaros:context-materials';output(await submit(${JSON.stringify({ baseRevision: snapshot.baseRevision, summary: 'Preserve stage progress and store reference', unresolved: [] })}));`
          ),
        }
      }
    } else if (!request.instructions.includes('velaros:agents')) {
      child++
      const goal = view.partitions.task.goals.at(-1).record.ref.id
      if (!seenGoals.has(goal)) {
        seenGoals.add(goal)
        const id = view.partitions.runtime.stores.active.items[0].id
        yield {
          type: 'text',
          text: block(
            request,
            'execute',
            `import {store} from 'velaros:system';import {read} from 'velaros:project';import {output} from 'velaros';const files=(await read({files:Array.from({length:12},(_,i)=>({path:'orders/batch-'+(i+1)+'.json'}))})).files;const orders=files.flatMap(f=>JSON.parse(f.text));const value={totalCents:0,approved:0,pending:0,count:orders.length};for(const order of orders){if(order.status==='approved'){value.totalCents+=order.cents;value.approved++}else value.pending++}const previous=await store.get({store:${JSON.stringify(id)},key:'result/summary'});output(await store.set({store:${JSON.stringify(id)},key:'result/summary',baseRevision:previous?.revision??0,value,event:{topic:'result/ready',value:{updated:true}}}));`
          ),
        }
      } else yield { type: 'text', text: marker(request) + ' done' }
    } else {
      main++
      const id = view.partitions.runtime.stores?.active.items[0]?.id
      let code
      if (main === 1)
        code =
          "import {store,memory} from 'velaros:system';import {output} from 'velaros';const space=await store.create({name:'handoff',description:'Four-stage order reconciliation'});await store.subscribe({store:space.id,topics:['result/']});output(await memory.update({key:'progress',baseRevision:0,body:'Four-stage reconciliation'}));"
      else if (main === 2) {
        code = `import {start,wait} from 'velaros:agents';import {output} from 'velaros';const job=await start({task:'Summarize all order batches into result/summary and notify result/ready',profile:'worker',stores:[{store:${JSON.stringify(id)},read:[''],write:['result/']}]});output(await wait({id:job.id}));`
        yield {
          type: 'text',
          text:
            block(
              request,
              'observe',
              `import {store} from 'velaros:system';import {output} from 'velaros';// Keep the current validated stage visible\noutput(await store.get({store:${JSON.stringify(id)},key:'result/summary'}),{key:'totals',purpose:'Current stage totals',view:{maxChars:2000}});`
            ) + '\n',
        }
      } else if ([4, 6, 8].includes(main)) {
        const phase = (main - 2) / 2,
          job = view.partitions.runtime.children[0]
        code = `import {ask} from 'velaros:interaction';import {resume,wait} from 'velaros:agents';import {output} from 'velaros';await ask({message:'revision:${phase}'});const job=await resume({id:${JSON.stringify(job.id)},input:'Re-read all actual inputs and update the same summary and notification'});output(await wait({id:job.id}));`
      } else if ([3, 5, 7, 9].includes(main)) {
        const phase = (main - 3) / 2
        if (phase === 3)
          yield {
            type: 'text',
            text:
              block(
                request,
                'observe',
                "import {read} from 'velaros:project';import {output} from 'velaros';// Continuously verify the persisted final report\noutput(await read({files:[{path:'report.json'}]}),{key:'final-report',purpose:'Verify the actual final report',view:{maxChars:4000}});"
              ) + '\n',
          }
        code = `import {store,memory} from 'velaros:system';import {edit} from 'velaros:project';import {output} from 'velaros';const item=await store.get({store:${JSON.stringify(id)},key:'result/summary'});if(!item)throw Error('missing summary');const page=await store.events({store:${JSON.stringify(id)}});if(!page)throw Error('missing subscription');await store.ack({store:${JSON.stringify(id)},ids:page.events.map(event=>event.id)});await edit({steps:[{action:'write',path:'stage-${phase}.json',text:JSON.stringify(item.value)+'\\n'}]});await memory.update({key:'stage-${phase}',baseRevision:0,body:'Stage ${phase} verified and persisted'});${phase === 0 ? "output(await memory.organize({focus:'Keep stage progress for continuation'}));" : ''}${phase === 3 ? "await edit({steps:[{action:'write',path:'report.json',text:JSON.stringify(item.value)+'\\n'}]});" : ''}output(item.value);`
      } else yield { type: 'text', text: marker(request) + ' done' }
      if (code) yield { type: 'text', text: block(request, 'execute', code) }
    }
    yield { type: 'usage', inputTokens: 100, outputTokens: 20 }
    yield { type: 'finish', reason: 'stop' }
  })
  const result = await runActEvaluation({
    model: driver,
    output: await output(t),
    scenario: 'reconciliation',
  })
  assert.equal(
    result.summary.passed,
    true,
    JSON.stringify({
      evidence: result.archive.legs[0].criteria[0].outcome,
      decisions: result.traces.map((turn) => JSON.parse(turn.decision.body)),
      results: result.traces.flatMap((turn) =>
        turn.records
          .filter((record) => record.title.endsWith(':result'))
          .map((record) => record.body)
      ),
    })
  )
  assert.equal(seenGoals.size, 4)
  assert(child >= 8 && child <= 16)
  assert.equal(main, 10)
  const root = join(result.summary.directory, 'project'),
    checker = evaluationScenario('reconciliation')
  await checker.restore({
    root,
    events: JSON.parse(await readFile(result.summary.eventsPath, 'utf8')),
  })
  const verify = (traces) =>
    checker.verify({
      root,
      traces,
      branches: result.branches,
      statePath: join(result.summary.directory, 'state/context.sqlite'),
      status: 'completed',
    })
  assert.equal((await verify(result.traces)).passed, true)
  const executedReads = structuredClone(result.traces)
  for (const turn of executedReads)
    for (const record of turn.invocations) {
      const call = JSON.parse(record.body)
      call.prepared.mode = 'execute'
      record.body = JSON.stringify(call)
    }
  assert.equal((await verify(executedReads)).evidence.checks.observedReport, false)
  const hidden = structuredClone(result.traces)
  for (const turn of hidden) {
    const request = JSON.parse(turn.request.body)
    for (const material of request.request.materials) {
      if (material.origin !== 'runtime-view') continue
      const frame = JSON.parse(material.text)
      frame.partitions.observation.bodyIncluded = false
      material.text = JSON.stringify(frame)
    }
    turn.request.body = JSON.stringify(request)
  }
  assert.equal((await verify(hidden)).evidence.checks.observedReport, false)
  const finalPath = join(root, 'report.json'),
    original = await readFile(finalPath, 'utf8')
  await writeFile(
    finalPath,
    JSON.stringify({ ...JSON.parse(original), extra: 'not part of the requested report' })
  )
  assert.equal((await verify(result.traces)).evidence.checks.final, false)
  await writeFile(finalPath, original)
  const stagePath = join(root, 'stage-0.json'),
    stage = JSON.parse(await readFile(stagePath, 'utf8'))
  await writeFile(stagePath, JSON.stringify({ ...stage, extra: true }))
  assert.equal((await verify(result.traces)).evidence.checks.stages, false)
})
