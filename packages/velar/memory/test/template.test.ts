/**
 * 代码模版是给模型看的日常用法示例：只过类型检查不够，结果取错一个键、写法跑不通，模型照着写就跟着错。
 * 这里把模版的每个函数接在真的文件档记忆库（纯内存）上，经真的代码面会话调一遍——和模型交程序是同一条路，
 * 落到的就是真的去重、读门与归档规则。
 */
import { describe, expect, test } from 'bun:test'

import { VelarMemoryModule } from '../index.js'
import { filesBackend, memorySpace, runModelProgram, storePort } from '../spec/support.js'

describe('代码模版', () => {
  test('每个函数照写法跑通：记一条、按话题召回、看画像、看最近、按 id 读、归档、连归档的一起找', async () => {
    const { backend } = filesBackend()
    const space = memorySpace(storePort(backend))
    const first = await runModelProgram(space, `${VelarMemoryModule.template}
export const remembered = await rememberPreference()
export const again = await rememberPreference()
export const recalled = await recall('回复风格')
export const portrait = await profile()
export const latest = await recent()
export const one = await readOne(remembered.id)
`)
    expect(first.failed).toBeUndefined()
    const values = first.value as Record<string, any>
    expect(values.remembered).toMatchObject({ isNew: true, availability: 'immediate' })
    expect(values.again).toMatchObject({ id: values.remembered.id, isNew: false })
    expect(values.recalled).toEqual([expect.objectContaining({ id: values.remembered.id, title: '回复风格', value: '用户偏好简洁中文回答，先给结论。', from: ['agent_tool'] })])
    expect(values.portrait).toEqual([expect.stringContaining('回复风格')])
    expect(values.latest).toEqual(['回复风格'])
    expect(values.one).toMatchObject({ title: '回复风格', sources: [values.remembered.id] })

    const second = await runModelProgram(space, `${VelarMemoryModule.template}
export const retired = await retire(${JSON.stringify(values.remembered.id)})
export const everyday = await recall('回复风格')
export const archived = await includingArchived('回复风格')
`)
    expect(second.failed).toBeUndefined()
    const after = second.value as Record<string, any>
    expect(after.retired).toContain('已归档')
    expect(after.everyday).toEqual([])
    expect(after.archived).toEqual(['回复风格'])
  }, 120_000)
})
