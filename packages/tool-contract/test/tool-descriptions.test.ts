/** 说明渲染与判定的实现细节：归一、精简、整类断言、概念表。 */

import { describe, expect, test } from 'bun:test'

import { toolDescriptions } from '../src/impl/ToolDescriptions'

describe('ToolDescriptions', () => {
  test('描述正文压成单行，条目逐条 trim 并丢掉空条目', () => {
    const rendered = toolDescriptions.renderTool({
      description: '  第一行\n  第二行  ',
      suitable: ['  有空白  ', '   ', '第二条'],
    })
    expect(rendered.split('\n\n')[0]).toBe('描述：第一行 第二行')
    expect(rendered).toContain('- 有空白\n- 第二条')
  })

  test('参数说明只有四节，没有必填分节', () => {
    const rendered = toolDescriptions.renderParameter({ description: '一次最多返回几条', values: ['1 到 50'] })
    expect(rendered).toBe('描述：一次最多返回几条\n\n取值：\n- 1 到 50')
    expect(toolDescriptions.isParameterDescription('描述：只有描述')).toBe(true)
    expect(toolDescriptions.isParameterDescription('取值：\n- 1')).toBe(false)
  })

  test('精简版保留强制流程整节，其余分节各留首条', () => {
    const rendered = toolDescriptions.renderTool({
      description: '写文件',
      suitable: ['第一条', '第二条'],
      protocol: ['先读再写', '写前确认'],
      notes: ['注意一', '注意二'],
    })
    const compact = toolDescriptions.compactTool(rendered)
    expect(compact).toContain('先读再写\n- 写前确认')
    expect(compact).toContain('适合：\n- 第一条')
    expect(compact).not.toContain('第二条')
    expect(compact).not.toContain('注意二')
    expect(toolDescriptions.isToolDescription(compact)).toBe(true)
  })

  test('整类断言只校验不改写，有一个不结构化就点名那个工具', () => {
    const good = toolDescriptions.renderTool({ description: '写文件', suitable: ['改文件'] })
    expect(toolDescriptions.forCategory({ write: { description: `  ${good}  ` } }, 'files').write.description).toBe(good)
    expect(() => toolDescriptions.forCategory({ write: { description: '随便写的' } }, 'files')).toThrow(/files\/write/u)
  })

  test('概念表取值按 key 返回登记的那句话', () => {
    expect(toolDescriptions.concept('boundedRead')).toContain('读取必须有界')
    const lookup = toolDescriptions.conceptLookup(toolDescriptions.defineConcepts({ probe: '探针约束' }))
    expect(lookup('probe')).toBe('探针约束')
  })
})
