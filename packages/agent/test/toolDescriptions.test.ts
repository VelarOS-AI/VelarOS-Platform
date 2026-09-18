/** 说明渲染与判定的实现细节：归一、参数说明的四节语法、整类断言。 */

import { describe, expect, test } from 'bun:test'

import { toolDescriptions } from '../src/impl/tools/ToolDescriptions'
import {
  isStructuredParameterDescription,
  renderParameterDescription,
  renderToolDescription,
} from '../src/utils/toolkit/tool-description'

describe('ToolDescriptions', () => {
  test('描述正文压成单行，条目逐条 trim 并丢掉空条目', () => {
    const rendered = renderToolDescription({
      description: '  第一行\n  第二行  ',
      suitable: ['  有空白  ', '   ', '第二条'],
    })
    expect(rendered.split('\n\n')[0]).toBe('描述：第一行 第二行')
    expect(rendered).toContain('- 有空白\n- 第二条')
  })

  test('参数说明只有四节，没有必填分节', () => {
    const rendered = renderParameterDescription({ description: '一次最多返回几条', values: ['1 到 50'] })
    expect(rendered).toBe('描述：一次最多返回几条\n\n取值：\n- 1 到 50')
    expect(isStructuredParameterDescription('描述：只有描述')).toBe(true)
    expect(isStructuredParameterDescription('取值：\n- 1')).toBe(false)
  })

  test('整类断言只校验不改写，有一个不结构化就点名那个工具', () => {
    const good = renderToolDescription({ description: '写文件', suitable: ['改文件'] })
    expect(toolDescriptions.forCategory({ write: { description: `  ${good}  ` } }, 'files').write.description).toBe(good)
    expect(() => toolDescriptions.forCategory({ write: { description: '随便写的' } }, 'files')).toThrow(/files\/write/u)
  })
})
