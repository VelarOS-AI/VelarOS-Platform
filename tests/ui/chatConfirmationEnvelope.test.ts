/**
 * 确认卡信封分发的回归锁。
 *
 * 锁的是 C1 判决：结构走 `detail.kind`，散文只兜底。反解中文字面量的那三条分支
 * （`系统工具安装申请` / `模型请求加载按需能力。` / `工作区授权请求`）已整体删除，
 * 本测试同时钉住"它们不会以任何形式回来"——纯散文一律走通用标题 + 折行正文。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, test } from 'node:test'

import { buildConfirmationPresentation } from '../../packages/ui/src/conversation/cards/chatConfirmationPresentation'

function translate(key: string, params?: Record<string, string | number>): string {
  const suffix = params
    ? Object.entries(params)
        .map(([name, value]) => `${name}=${String(value)}`)
        .join(',')
    : ''
  return suffix ? `${key}(${suffix})` : key
}

void describe('chat confirmation envelope', () => {
  void test('falls back to prose when no structured detail is present', () => {
    const presentation = buildConfirmationPresentation({
      message: '工具授权请求\n类型：系统\n工具：system:run',
      detail: null,
      t: translate,
    })

    assert.equal(presentation.title, 'status.awaitingConfirmation')
    assert.equal(presentation.description, '工具授权请求 类型：系统 工具：system:run')
    assert.deepEqual(presentation.facts, [])
  })

  void test('uses the generic description when prose is blank', () => {
    const presentation = buildConfirmationPresentation({
      message: '   \n  ',
      detail: null,
      t: translate,
    })

    assert.equal(presentation.description, 'status.awaitingConfirmationDescription')
  })

  void test('dispatches tool category authorization by kind, not by prose', () => {
    const presentation = buildConfirmationPresentation({
      // 散文故意与结构不一致：结构赢，散文只在缺席时才被读。
      message: '随便什么文案',
      detail: {
        kind: 'tool-category-authorization',
        categoryId: 'system',
        categoryLabel: '系统',
        toolName: 'system:run',
      },
      t: translate,
    })

    assert.equal(presentation.title, 'confirmation.toolCategoryTitle')
    assert.equal(presentation.description, 'confirmation.toolCategoryDescription(category=系统)')
    assert.deepEqual(presentation.facts, ['confirmation.toolCategoryTool(tool=system:run)'])
  })

  void test('dispatches mcp tool calls and skill loads by kind', () => {
    const mcp = buildConfirmationPresentation({
      message: null,
      detail: { kind: 'mcp-tool-call', serverName: 'github', toolName: 'create_issue' },
      t: translate,
    })
    assert.equal(mcp.title, 'confirmation.mcpToolTitle')
    assert.equal(
      mcp.description,
      'confirmation.mcpToolDescription(server=github,tool=create_issue)'
    )

    const skill = buildConfirmationPresentation({
      message: null,
      detail: {
        kind: 'skill-load',
        skillId: 'deep-research',
        label: '深度调研',
        description: '并行拆题后汇总',
      },
      t: translate,
    })
    assert.equal(skill.title, 'confirmation.skillLoadTitle')
    assert.deepEqual(skill.facts, [
      '并行拆题后汇总',
      'confirmation.skillLoadId(id=deep-research)',
    ])
  })

  void test('an unknown kind falls back to prose instead of rendering blank', () => {
    const presentation = buildConfirmationPresentation({
      message: '未来某个宿主发来的确认',
      // 宿主比包新：包不认识的 kind 必须走散文，不能白屏。
      detail: { kind: 'future-kind' } as never,
      t: translate,
    })

    assert.equal(presentation.title, 'status.awaitingConfirmation')
    assert.equal(presentation.description, '未来某个宿主发来的确认')
  })

  void test('shows the exact MCP argument preview and the scope of approval', () => {
    for (const approvalScope of ['call', 'session-tool'] as const) {
      const presentation = buildConfirmationPresentation({
        message: 'fallback prose must not hide the structured arguments',
        detail: {
          kind: 'mcp-tool-call', serverName: 'records', toolName: 'delete',
          argumentsPreview: '{"target":"record-A","token":"[redacted]"}', approvalScope,
        },
        t: translate,
      })
      assert.deepEqual(presentation.facts, [
        'confirmation.mcpToolArguments(arguments={"target":"record-A","token":"[redacted]"})',
        approvalScope === 'call' ? 'confirmation.mcpToolCallScope' : 'confirmation.mcpToolSessionScope',
      ])
    }
  })

  void test('task scope, requester and rejection behavior are displayed from authorization metadata', () => {
    const presentation = buildConfirmationPresentation({
      message: 'Apply the update?', t: translate,
      detail: { kind: 'operation-authorization', authorization: {
        label: 'Update deployment', target: 'staging', requester: 'Worker A', scope: 'task-operation',
      } },
    })
    assert.equal(presentation.title, 'Update deployment')
    assert.deepEqual(presentation.facts, [
      'taskApproval.target(target=staging)',
      'taskApproval.requester(requester=Worker A)',
      'taskApproval.operationScope',
      'taskApproval.denialContinues',
    ])
  })

  void test('the retired Chinese-literal prose parsers stay deleted', () => {
    const source = readFileSync(
      new URL('../../packages/ui/src/conversation/cards/ChatConfirmationCard.tsx', import.meta.url),
      'utf8'
    )
    const presentation = readFileSync(
      new URL(
        '../../packages/ui/src/conversation/cards/chatConfirmationPresentation.ts',
        import.meta.url
      ),
      'utf8'
    )

    // 判据是「有没有拿中文字面量做相等比较」，不是「文件里出现过这几个字」——
    // 判决说明本身要引用它们，正文提及不算复活。
    for (const literal of ['系统工具安装申请', '模型请求加载按需能力。', '工作区授权请求']) {
      for (const code of [source, presentation]) {
        assert.equal(code.includes(`=== '${literal}'`), false, `${literal} 反解分支不得回来`)
        assert.equal(code.includes(`!== '${literal}'`), false, `${literal} 反解分支不得回来`)
        assert.equal(code.includes(`startsWith('${literal}`), false, `${literal} 反解分支不得回来`)
      }
    }
    assert.equal(presentation.includes('readPrefixedLine'), false)
    assert.equal(source.includes('readPrefixedLine'), false)
  })
})
