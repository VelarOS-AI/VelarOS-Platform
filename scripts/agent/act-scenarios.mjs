import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { localContextStorage } from '../../packages/context/dist/node.js'

const raw = (record) =>
  record && !record.truncated && record.body !== null ? JSON.parse(record.body) : null
const calls = (traces) => [
  ...new Map(
    traces
      .flatMap((trace) => trace.invocations.map(raw).filter(Boolean))
      .map((value) => [value.prepared.id, value])
  ).values(),
]
const frames = (traces) =>
  traces.flatMap((trace) => {
    const material = raw(trace.request)?.request.materials.find(
      (item) => item.origin === 'runtime-view'
    )
    return material ? [JSON.parse(material.text)] : []
  })
const completed = (traces, module, operation) =>
  calls(traces).filter(
    (item) =>
      item.prepared.binding.moduleId === module &&
      item.prepared.operation === operation &&
      item.receipt?.outcome === 'succeeded'
  )
const json = async (root, name) => {
  try {
    return JSON.parse(await readFile(join(root, name), 'utf8'))
  } catch {
    return null
  }
}

// 汇总只接受约定字段及精确数值，避免额外字段掩盖不符合任务的交付。
const exactReport = (value, expected) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).length === Object.keys(expected).length &&
  Object.entries(expected).every(([key, number]) => value[key] === number)

// 把实际观察读取回执关联到被模型接受的可见观察，不能用文件落盘或旧观察次数代替。
function observedReport(traces, expected) {
  return traces.some((trace) => {
    if (raw(trace.decision)?.status !== 'accepted') return false
    const observation = frames([trace])[0]?.partitions.observation
    if (!observation?.bodyIncluded || !observation.text) return false
    const result = raw(trace.records.find((record) => record.ref.id === observation.resultRef))
    if (result?.mode !== 'observe') return false
    return completed([trace], 'velaros:project', 'read').some(
      (call) =>
        call.prepared.mode === 'observe' &&
        call.prepared.executionId === result.executionId &&
        call.receipt.value?.files?.some((file) => {
          if (file.path !== 'report.json') return false
          try {
            return exactReport(JSON.parse(file.text), expected)
          } catch {
            return false
          }
        })
    )
  })
}

// 按投递 ID 和持久确认回执核对消息；确认后的空轮询不覆盖已经处理的事实。
async function consumedMessages(storage, spaceId, traces) {
  const delivered = completed(traces, 'velaros:system-store', 'events')
    .filter((call) => call.prepared.input.store === spaceId)
    .flatMap((call) => call.receipt.value?.events ?? [])
  const events = [...new Map(delivered.map((event) => [event.id, event])).values()]
  const acks = completed(traces, 'velaros:system-store', 'ack').filter(
    (call) => call.prepared.input.store === spaceId
  )
  const confirmed = new Set(
    (
      await Promise.all(acks.map((call) => storage.stores.receipt(spaceId, call.prepared.id)))
    ).flatMap((receipt) => receipt?.ids ?? [])
  )
  return {
    events,
    confirmed: [...confirmed],
    acknowledged: events.length > 0 && events.every((event) => confirmed.has(event.id)),
  }
}

// 工作负载只定义任务、输入和独立判据，执行始终交给正式 Runtime。
export function evaluationScenario(name) {
  if (name === 'read-edit-observe') return null
  if (name === 'system-cooperation')
    return {
      id: name,
      title: '持久状态、子任务、消息与上下文整理',
      modelTools: true,
      files: { 'orders.json': JSON.stringify([12, 7, 25, 6]) + '\n' },
      prompt:
        '完成 orders.json 的汇总。在脚本中解析完整真实 JSON 并求和、计数，确认读取完整后再保存。父线独立核验不匹配时，resume 同一个 worker 重新读取并纠正。先创建名为 handoff、用途明确的 store，记录输入并订阅 result/ 消息；在工作笔记 progress 中记录目标。派发一个 worker 子任务读取 orders.json，把 {total,count} 写入共享空间的 result/summary，并通过同一 set 的 event 发布 result/ready；父线要先订阅再派发，给子任务明确的 store 读写授权，子任务无需外部写权限。父线读取并核实子结果，确认处理对应消息；在子任务收束后让 memory.organize 整理一次工作上下文，确认 memoryStatus.maintenance.lastAttempt.status 为 applied 后继续；失败反馈需要处理后重试。写 report.json 为 {total,count}，用带稳定 key 和 purpose 的 observe 持续核实报告，最终确认后完成。脚本中用 output 选择必要上下文，勿把整个历史反复输出。保留所有输入及 protected.txt。按真实合同先发现所需模块和 profiles。',
      async verify({ root, traces, branches, statePath, status }) {
        const all = [...traces, ...branches.flatMap((branch) => branch.turns)],
          storage = localContextStorage({ path: statePath })
        try {
          const directory = await storage.stores.directory(
            'session:evaluation',
            'evaluation',
            [],
            undefined,
            64
          )
          const spaces = directory.items.filter((item) => item.name === 'handoff'),
            space = spaces[0]
          const result = space ? await storage.stores.get(space.id, 'result/summary') : null
          const messages = await consumedMessages(storage, space?.id, traces)
          const state = await storage.load('evaluation')
          const outcomes = await Promise.all(
            (state?.records ?? [])
              .filter((item) => item.title === 'context-maintenance:outcome')
              .map(async (item) => JSON.parse(await storage.get('evaluation', item.objectId)))
          )
          const report = await json(root, 'report.json'),
            source = await json(root, 'orders.json')
          const checks = {
            completed: status === 'completed',
            report: report?.total === 50 && report?.count === 4,
            source: JSON.stringify(source) === '[12,7,25,6]',
            oneSpace: spaces.length === 1,
            childResult:
              result?.value?.total === 50 &&
              result?.value?.count === 4 &&
              result.actor.startsWith('agent:'),
            message:
              messages.events.length > 0 &&
              messages.events.every(
                (event) => event.topic === 'result/ready' && event.actor.startsWith('agent:')
              ),
            acknowledged: messages.acknowledged,
            child: branches.some((branch) => branch.kind === 'agent' && branch.turns.length),
            maintenance: outcomes.some((item) => item.status === 'applied'),
            note: completed(all, 'velaros:system-memory-persistent', 'update').length > 0,
            stableReference:
              space &&
              frames(traces).filter((frame) =>
                frame.partitions.runtime.stores?.active.items.some((item) => item.id === space.id)
              ).length >= 2,
            observedReport: frames(traces).some((frame) =>
              frame.partitions.observation?.text?.includes('50')
            ),
            protected: (await readFile(join(root, 'protected.txt'), 'utf8')) === 'keep this\n',
          }
          return {
            passed: Object.values(checks).every(Boolean),
            evidence: {
              checks: Object.fromEntries(
                Object.entries(checks).map(([key, value]) => [key, Boolean(value)])
              ),
              report,
              storeId: space?.id ?? null,
              result,
              messages,
              maintenance: outcomes,
            },
          }
        } finally {
          await storage.close()
        }
      },
    }
  if (name === 'semantic-search')
    return {
      id: name,
      title: '高级搜索证据、修复与当前观察',
      modelTools: true,
      files: {
        'src/session.mjs':
          '// Authentication session validity.\nexport function isActive(session, now) {\n  return session.expiresAt >= now && !session.revoked;\n}\n',
        'src/display.mjs':
          '// Expiry presentation is not the authorization decision.\nexport const displayExpiry = session => String(session.expiresAt);\n',
        'requirements.md':
          '认证规则：有效期上界排除，当前时间等于 expiresAt 时必须失效；revoked 会话始终失效。\n',
      },
      prompt:
        '调查并修复会话到期边界问题。先用 velaros:search 的高级搜索找出认证判断、需求和相关影响，取得带真实证据 ID 的报告；之后使用 read 的 current 模式核实选定证据。结合 requirements.md 修改实际判断，保留展示逻辑和 protected.txt。修复后用 observe 返回当前代码和必要依据，再完成。搜索的档位通过 profiles 选择，所用证据必须来自 Runtime 读取。',
      async verify({ root, traces, branches, status }) {
        const all = [...traces, ...branches.flatMap((branch) => branch.turns)]
        const check = spawnSync(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            "import {isActive} from './src/session.mjs'; const cases=[[{expiresAt:10,revoked:false},9,true],[{expiresAt:10,revoked:false},10,false],[{expiresAt:10,revoked:false},11,false],[{expiresAt:10,revoked:true},9,false]]; if(cases.some(([s,n,e])=>isActive(s,n)!==e))process.exit(2);",
          ],
          { cwd: root, env: { PATH: process.env.PATH ?? '' }, timeout: 10000, encoding: 'utf8' }
        )
        const reports = completed(traces, 'velaros:search', 'search').map(
          (item) => item.receipt.value
        )
        const checks = {
          completed: status === 'completed',
          behavior: check.status === 0,
          search: reports.some(
            (report) =>
              report.evidence?.length &&
              report.findings?.some((finding) => finding.evidenceIds.length)
          ),
          refreshed: completed(traces, 'velaros:search', 'read').some(
            (item) =>
              item.prepared.input.mode === 'current' &&
              item.receipt.value.items.some((value) => value.ok)
          ),
          leaf: branches.some((branch) => branch.kind === 'search' && branch.turns.length),
          evidence: completed(all, 'velaros:evidence', 'read').length > 0,
          observation: frames(traces).some((frame) =>
            frame.partitions.observation?.text?.includes('isActive')
          ),
          display:
            (await readFile(join(root, 'src/display.mjs'), 'utf8')) ===
            '// Expiry presentation is not the authorization decision.\nexport const displayExpiry = session => String(session.expiresAt);\n',
          protected: (await readFile(join(root, 'protected.txt'), 'utf8')) === 'keep this\n',
        }
        return {
          passed: Object.values(checks).every(Boolean),
          evidence: {
            checks,
            exitCode: check.status,
            stderr: check.stderr,
            searchReports: reports.map((report) => ({
              status: report.status,
              evidence: report.evidence.length,
              gaps: report.gaps,
            })),
          },
        }
      },
    }
  if (name === 'reconciliation') {
    const source = Object.fromEntries(
      Array.from({ length: 12 }, (_, batch) => [
        `orders/batch-${batch + 1}.json`,
        Array.from({ length: 80 }, (_, i) => ({
          id: `${batch + 1}-${i + 1}`,
          cents: 100 + batch * 17 + i * 3,
          status: i % 7 === 0 ? 'pending' : 'approved',
        })),
      ])
    )
    const total = () =>
      Object.values(source)
        .flat()
        .reduce(
          (r, item) => {
            if (item.status === 'approved') {
              r.totalCents += item.cents
              r.approved++
            } else r.pending++
            r.count++
            return r
          },
          { totalCents: 0, approved: 0, pending: 0, count: 0 }
        )
    const initial = structuredClone(source),
      expected = [total()],
      answered = new Set()
    const revise = (phase) => {
      if (phase === 1) source['orders/batch-3.json'][1].cents += 731
      if (phase === 2) source['orders/batch-8.json'][2].status = 'pending'
      if (phase === 3)
        source['orders/batch-12.json'].push({ id: '12-81', cents: 999, status: 'approved' })
    }
    for (let phase = 1; phase <= 3; phase++) {
      revise(phase)
      expected.push(total())
    }
    const final = structuredClone(source)
    Object.assign(source, initial)
    return {
      id: name,
      title: '分阶段订单核对与同一子任务续跑',
      modelTools: true,
      files: Object.fromEntries(
        Object.entries(initial).map(([file, orders]) => [file, JSON.stringify(orders) + '\n'])
      ),
      prompt:
        '核对 orders/ 下全部 12 批订单，只汇总 status=approved 的 cents，报告严格为 {totalCents,approved,pending,count}，pending 表示所有未批准订单数量。创建 handoff store 并先订阅 result/ 消息，笔记记录推进阶段。派发一个 worker 读取全部真实文件并将汇总写入 result/summary，同时原子发布 result/ready。主线核验、处理并确认消息，将初始汇总写入 stage-0.json。之后通过 interaction.ask 依次请求 revision:1、revision:2、revision:3；宿主会在每次回答前实际修订输入，必须先收到回答，再 resume 原来的同一个子任务，重新读取实际输入、更新同一 store 键并发布新通知。每阶段主线确认消息后将对应结果写到 stage-1.json、stage-2.json、stage-3.json。每完成一个阶段更新工作笔记；在子任务已收束的阶段边界，至少完成一次上下文整理并确认 memoryStatus.maintenance.lastAttempt.status 为 applied，失败反馈需要处理后重试；让 observe 持续提供当前阶段、输入/结果状态等必要信息，使用有目的和上限的输出。每个 stage-N.json 必须落盘之后才能请求下一阶段。最后将最新汇总写入 report.json，并通过下一轮 observe 核实后完成。保留所有原始输入供宿主修订，保留 protected.txt。不要创建新的子任务来代替续跑。按真实模块合同发现用法和档位。',
      async restore({ root, events }) {
        if (answered.size) throw Error('修订检查点已经装载')
        const requests = new Map(
          events
            .filter((event) => event.type === 'interaction')
            .map((event) => [event.request.id, event.request])
        )
        for (const event of events.filter((event) => event.type === 'answer')) {
          const request = requests.get(event.id),
            phase = Number(request?.message.match(/revision:([123])/u)?.[1])
          if (request?.kind !== 'input' || !phase) throw Error('检查点缺少对应的修订请求')
          if (answered.has(phase)) continue
          if (phase !== answered.size + 1) throw Error('检查点中的修订回答顺序不正确')
          revise(phase)
          answered.add(phase)
        }
        for (const [path, orders] of Object.entries(source))
          if (JSON.stringify(await json(root, path)) !== JSON.stringify(orders))
            throw Error('检查点与当前真实订单不一致')
      },
      async answer({ root, request }) {
        const phase = Number(request.message.match(/revision:([123])/u)?.[1])
        if (request.kind !== 'input' || !phase)
          throw Error('工作负载只预设 revision:1/2/3 的修订回答')
        if (!exactReport(await json(root, `stage-${phase - 1}.json`), expected[phase - 1]))
          throw Error('请求下一阶段前，当前阶段报告尚未正确落盘')
        if (!answered.has(phase)) {
          if (phase !== answered.size + 1) throw Error('必须依次处理修订')
          revise(phase)
          const file =
            phase === 1
              ? 'orders/batch-3.json'
              : phase === 2
                ? 'orders/batch-8.json'
                : 'orders/batch-12.json'
          await writeFile(join(root, file), JSON.stringify(source[file]) + '\n')
          answered.add(phase)
        }
        return `revision:${phase} 已写入真实订单文件。续跑原子任务重新核验；当前源文件是事实依据。`
      },
      async verify({ root, traces, branches, statePath, status }) {
        const reports = await Promise.all(expected.map((_, i) => json(root, `stage-${i}.json`)))
        const report = await json(root, 'report.json'),
          storage = localContextStorage({ path: statePath })
        try {
          const directory = await storage.stores.directory(
              'session:evaluation',
              'evaluation',
              [],
              undefined,
              64
            ),
            spaces = directory.items,
            space = spaces[0]
          const result = space ? await storage.stores.get(space.id, 'result/summary') : null
          const jobs = completed(traces, 'velaros:agents', 'start'),
            resumes = completed(traces, 'velaros:agents', 'resume')
          const childId = jobs[0]?.receipt.value.id
          const messages = await consumedMessages(storage, space?.id, traces)
          const state = await storage.load('evaluation')
          const outcomes = await Promise.all(
            (state?.records ?? [])
              .filter((item) => item.title === 'context-maintenance:outcome')
              .map(async (item) => JSON.parse(await storage.get('evaluation', item.objectId)))
          )
          const checks = {
            completed: status === 'completed',
            stages: reports.every((report, i) => exactReport(report, expected[i])),
            final: exactReport(report, expected[3]),
            observedReport: observedReport(traces, expected[3]),
            source: (
              await Promise.all(
                Object.entries(final).map(
                  async ([path, value]) =>
                    JSON.stringify(await json(root, path)) === JSON.stringify(value)
                )
              )
            ).every(Boolean),
            answers: answered.size === 3,
            oneChild:
              jobs.length === 1 &&
              resumes.length >= 3 &&
              resumes.every((item) => item.prepared.input.id === childId),
            childHistory: branches.some(
              (branch) =>
                branch.kind === 'agent' &&
                new Set(branch.turns.map((turn) => raw(turn.request)?.runId)).size >= 4
            ),
            state:
              spaces.length === 1 &&
              result?.revision >= 4 &&
              result?.actor.startsWith('agent:') &&
              Object.entries(expected[3]).every(([key, value]) => result.value[key] === value),
            ack:
              messages.events.length >= 4 &&
              messages.acknowledged &&
              messages.events.every(
                (event) => event.topic === 'result/ready' && event.actor.startsWith('agent:')
              ),
            maintenance: outcomes.some((outcome) => outcome.status === 'applied'),
            notes: completed(traces, 'velaros:system-memory-persistent', 'update').length >= 4,
            observe:
              frames(traces).filter((frame) => frame.partitions.observation?.text).length >= 4,
            protected: (await readFile(join(root, 'protected.txt'), 'utf8')) === 'keep this\n',
          }
          return {
            passed: Object.values(checks).every(Boolean),
            evidence: {
              checks: Object.fromEntries(
                Object.entries(checks).map(([key, value]) => [key, Boolean(value)])
              ),
              expected,
              reports,
              report,
              result,
              answered: [...answered],
            },
          }
        } finally {
          await storage.close()
        }
      },
    }
  }
  throw new Error(`未知工作负载：${name}`)
}
