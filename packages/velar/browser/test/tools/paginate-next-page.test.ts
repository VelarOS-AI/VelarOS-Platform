// 用途：钉住翻页只点「明确自称下一页」的元素，而且点击走空间端口。
// 历史事故：缺省 selector 里的 `[class*="next"]` 会匹配 class 带 next 的任何元素
// （例如「next-article」推荐卡片），`[class*="pagination"] a:last-child` 会点到「末页」；
// 点击又是经求值通道在页面里 el.click()，宿主的动作策略把它当「执行脚本」判，
// 既没有遮挡检测也没有效果指纹。
import assert from 'node:assert/strict'

import { describe, test } from 'bun:test'

import type { BrowserOperationContext } from '../../contract/requires.js'
import { browserOperations } from '../../impl/BrowserOperations.js'

interface PaginationProbeOptions {
  /** 每次「下一页」点击是否命中。 */
  clickMatches?: boolean
}

function createPaginationProbe(options: PaginationProbeOptions = {}) {
  const scripts: string[] = []
  const targetActions: Array<Record<string, unknown>> = []
  let page = 0
  const browser = {
    isActive: () => true,
    getContext: () => ({ url: 'https://example.test/list', workspaceRoot: '/tmp/site' }),
    evaluateScript: async (input: { script: string }) => {
      scripts.push(input.script)
      // 列表提取：每页两条，内容随页码变化。
      if (input.script.startsWith('JSON.stringify(')) {
        page += 1
        return {
          ok: true,
          result: JSON.stringify({
            ok: true,
            items: [{ title: `p${page}-a` }, { title: `p${page}-b` }],
            itemCount: 2,
          }),
          resultTruncated: false,
        }
      }
      // 下一页存在性探测。
      return { ok: true, result: true, resultTruncated: false }
    },
    performTargetAction: async (input: Record<string, unknown>) => {
      targetActions.push(input)
      return {
        action: 'click',
        url: 'https://example.test/list',
        matched: options.clickMatches ?? true,
        selector: null,
        text: null,
        failureReason: options.clickMatches === false ? 'not-found' : undefined,
        capturedAt: 0,
      }
    },
  }

  return {
    scripts,
    targetActions,
    ctx: { browser, abortSignal: new AbortController().signal } as unknown as BrowserOperationContext,
  }
}

async function runPaginate(probe: ReturnType<typeof createPaginationProbe>, maxPages: number) {
  return browserOperations.paginate({ maxPages, maxItemsPerPage: 10 }, probe.ctx)
}

void describe('翻页提取的下一页', () => {
  void test('缺省选择器只认 rel=next 与 aria 标签，不再匹配 class 里带 next 的元素', async () => {
    const probe = createPaginationProbe()

    await runPaginate(probe, 2)

    const selector = String(
      (probe.targetActions[0]?.target as { css: string } | undefined)?.css
    )
    assert.match(selector, /a\[rel="next"\]/u)
    assert.match(selector, /aria-label\*="下一页"/u)
    assert.doesNotMatch(selector, /class\*="next"/u)
    assert.doesNotMatch(selector, /pagination/u)
  })

  void test('点击走空间端口的 performTargetAction，不再在页面里 el.click()', async () => {
    const probe = createPaginationProbe()

    const result = await runPaginate(probe, 2)

    assert.equal(result.pagesVisited, 2)
    assert.equal(probe.targetActions[0]?.action, 'click')
    assert.ok(probe.targetActions.length >= 1)
    assert.ok(probe.scripts.every((script) => !script.includes('.click()')))
  })

  void test('下一页点不中就停，不把同一页再收一遍', async () => {
    const probe = createPaginationProbe({ clickMatches: false })

    const result = await runPaginate(probe, 5)

    assert.equal(result.pagesVisited, 1)
    assert.equal(result.items.length, 2)
    assert.equal(probe.targetActions.length, 1)
  })
})
