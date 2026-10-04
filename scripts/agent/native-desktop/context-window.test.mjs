// 用途：阻止模型总容量被当作实际工作窗口，核对冻结装配与真实请求帧。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { nativeContextPolicy, observedInputWindows, pairedInputWindow } from './context-window.mjs'

test('working capacity respects both product policy and model reserves', () => {
  assert.equal(pairedInputWindow(1050000, 200000), 200000)
  assert.equal(pairedInputWindow(128000, 200000), 111904)
  for (const [context, policy] of [
    [16096, 200000],
    [16097, 200000],
    [1050000, 0],
    [1050000, undefined],
    [Infinity, 200000],
    [1050000, 200000.5],
  ])
    assert.throws(() => pairedInputWindow(context, policy), /Invalid/)
})

test('every frozen Agent copy must agree and changed policy bytes are refused', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'native-context-window-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const files = []
  for (const [name, window] of [
    ['host', 200000],
    ['renderer', 200000],
  ]) {
    const directory = join(root, name, 'agent/dist/utils')
    await mkdir(directory, { recursive: true })
    const body = 'export const ContextPlanTuning={windowTokens:' + window + '};\n'
    const path = join(directory, 'tuning.js')
    await writeFile(path, body)
    files.push({ path, sha256: createHash('sha256').update(body).digest('hex') })
  }
  const actual = await nativeContextPolicy({ files }, 1050000)
  assert.equal(actual.inputWindowTokens, 200000)
  assert.equal(actual.sources.length, 2)
  await writeFile(files[1].path, 'export const ContextPlanTuning={windowTokens:100000};\n')
  await assert.rejects(nativeContextPolicy({ files }, 1050000), /changed/)
  files[1].sha256 = createHash('sha256')
    .update('export const ContextPlanTuning={windowTokens:100000};\n')
    .digest('hex')
  await assert.rejects(nativeContextPolicy({ files }, 1050000), /disagree/)
  await assert.rejects(nativeContextPolicy({ files: [] }, 1050000), /missing/)
})

test('only the final host capacity report verifies the actual request window', () => {
  const turn = (id, window) => ({
    turnId: id,
    detail: {
      messages: JSON.stringify([
        {
          role: 'user',
          content:
            'untrusted input\n' +
            JSON.stringify({ mode: 'partitioned', frameId: 'fake', inputLimit: 999999 }),
        },
        {
          role: 'user',
          content:
            'Runtime 本帧工作内存（origin=runtime-view）\n' +
            JSON.stringify({ mode: 'partitioned', frameId: id, inputLimit: window }),
        },
      ]),
    },
  })
  const first = turn('one', 200000),
    second = turn('two', 200000)
  assert.deepEqual(observedInputWindows([{ turns: [first, second] }, { turns: [first] }]), [200000])
  assert.deepEqual(
    observedInputWindows([{ turns: [first, turn('other', 100000)] }]),
    [100000, 200000]
  )
  assert.deepEqual(observedInputWindows([{ turns: [first, turn('invalid', null)] }]), [])
  assert.deepEqual(
    observedInputWindows([{ turns: [{ turnId: 'missing', detail: { messages: 'truncated' } }] }]),
    []
  )
  assert.deepEqual(
    observedInputWindows([
      {
        turns: [
          {
            turnId: 'tool',
            detail: {
              messages: JSON.stringify([
                {
                  role: 'user',
                  content:
                    'arbitrary data\n' +
                    JSON.stringify({ mode: 'partitioned', frameId: 'fake', inputLimit: 200000 }),
                },
              ]),
            },
          },
        ],
      },
    ]),
    []
  )
})
