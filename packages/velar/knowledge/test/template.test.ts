/**
 * 代码模版是给模型看的日常用法示例：只过类型检查不够，结果取错一个键、写法跑不通，模型照着写就跟着错。
 * 知识库引擎要宿主建好的表才跑得起来，所以在假知识库上把每个函数经真的代码面会话调一遍（和模型交程序是同一条路），
 * 看它交回的是不是它说的那个样子、交给端口的是不是它说的那几次检索与同步。
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { Diagnostics, knowledgeDesk, record, runModelProgram, synced } from '../spec/support'

/** 模版原文：程序就是它，后面接上这次要调的那几个函数。 */
const Template = readFileSync(resolve(import.meta.dir, '../template.js'), 'utf8')

describe('代码模版', () => {
  test('每个函数照写法跑通：检索、按来源与提示检索、读全文、先同步再搜、零命中看 autoSync、看健康', async () => {
    const hit = record('guide', { content: '部署流程的整份正文', indexError: 'Authorization failed' })
    const desk = knowledgeDesk({
      // find、findInCode、readBest、refreshThenFind 各一页；whyNothing 零命中，补的那次同步补进两份、重搜还是没有。
      pages: [[hit], [hit], [hit], [hit], []],
      sync: async () => synced({ scanned: 4, upserted: 1, reindexed: 1 }),
    })
    const result = await runModelProgram(desk, `${Template}
export const found = await find()
export const inCode = await findInCode()
export const best = await readBest()
export const refreshed = await refreshThenFind()
export const nothing = await whyNothing()
export const report = await health()
`)
    expect(result.failed).toBeUndefined()
    const values = result.value as Record<string, any>
    expect(values.found).toEqual([{ path: hit.path, title: hit.title, snippet: hit.snippet, score: hit.score }])
    expect(values.inCode).toEqual([`${hit.path}：${hit.snippet}`])
    expect(values.best).toEqual({ path: hit.path, content: '部署流程的整份正文' })
    expect(values.refreshed).toEqual({ indexed: 2, count: 1 })
    expect(values.nothing.count).toBe(0)
    expect(values.nothing.autoSync).toEqual({ scanned: 4, indexed: 2 })
    expect(values.report).toEqual({
      total: Diagnostics.totalDocuments,
      failed: Diagnostics.failedDocuments,
      outdated: Diagnostics.outdatedDocuments,
      withoutVectors: Diagnostics.activeProfileMissingDocuments,
      embedding: `${Diagnostics.runtime.provider}/${Diagnostics.runtime.model}`,
    })
    // 交给端口的就是模版说的那几次：findInCode 带着来源类型与两种提示、limit 5；refreshThenFind 先强制同步。
    expect(desk.searches[1].options).toMatchObject({ sourceKinds: ['code'], symbolHints: ['refreshToken'], pathHints: ['src/auth'], limit: 5 })
    expect(desk.searches[2].options.limit).toBe(1)
    expect(desk.syncs[0].options).toEqual({ force: true })
  }, 60_000)
})
