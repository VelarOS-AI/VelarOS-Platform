/** 编解码的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补识别的边角、流式识别与按原字节保留编码的退路。 */

import { describe, expect, test } from 'bun:test'

import { textCodec, TextEncodings, TextFileErrorCodes } from '../index'

describe('编码识别', () => {
  test.each(TextEncodings)('逐字节喂进流式识别与一次识别结论一致：%s', (encoding) => {
    const bytes = textCodec.encode('long ascii source\r\n中文🙂é\\n\\uD800\r\n', encoding)
    const probe = textCodec.createProbe()
    for (const byte of bytes) probe.push(Uint8Array.of(byte))
    expect(probe.finish()).toBe(encoding)
    expect(textCodec.detect(bytes)).toBe(encoding)
  })

  test('按块解码器：GB18030 被块边界切开的字接到下一块，末尾没凑齐的字节在收尾时报错', () => {
    const bytes = textCodec.encode('中🙂文', 'gb18030')
    for (let cut = 1; cut < bytes.length; cut += 1) {
      const decoder = textCodec.createDecoder('gb18030')
      expect(decoder.push(bytes.subarray(0, cut)) + decoder.push(bytes.subarray(cut)) + decoder.finish()).toBe('中🙂文')
    }
    const truncated = textCodec.createDecoder('gb18030')
    truncated.push(bytes.subarray(0, bytes.length - 1))
    expect(() => truncated.finish()).toThrow()
    expect(textCodec.detect(bytes.subarray(0, bytes.length - 1))).not.toBe('gb18030')
  })

  test('流式识别逐块喂进被切开的 GB18030 字，结论与一次识别一致', () => {
    const bytes = textCodec.encode(`${'x'.repeat(10)}中🙂文注释`, 'gb18030')
    for (const size of [1, 2, 3, 5, 7]) {
      const probe = textCodec.createProbe()
      for (let offset = 0; offset < bytes.length; offset += size) probe.push(bytes.subarray(offset, offset + size))
      expect(probe.finish()).toBe('gb18030')
    }
  })

  test.each(['utf16le-nobom', 'utf16be-nobom'] as const)('极短的无 BOM %s 靠 ASCII 与 NUL 交错认出字节序', (encoding) => {
    for (const text of ['a', 'a\n', '\r\n', 'x = 1\n']) {
      const bytes = textCodec.encode(text, encoding)
      expect(textCodec.detect(bytes)).toBe(encoding)
      expect(textCodec.decode(bytes)).toEqual({ content: text, encoding })
    }
    // 纯非 ASCII 的极短文本不凭长度猜字节序。
    expect(textCodec.detect(textCodec.encode('中', encoding))).not.toBe(encoding)
  })

  test('只给了文件开头时，末尾被截断的多字节字符不算错；读到末尾才核对', () => {
    const bytes = Buffer.from('abc中')
    const cut = bytes.subarray(0, bytes.length - 1)
    expect(textCodec.detect(cut)).toBe('gb18030')
    expect(textCodec.detect(cut, { partial: true })).toBe('utf8')
    const truncatedBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('ok'), Buffer.from([0xf0, 0x9f])])
    expect(textCodec.detect(truncatedBom)).toBeNull()
    expect(textCodec.detect(truncatedBom, { partial: true })).toBe('utf8-bom')
  })

  test('GBK 的文件认成 gb18030，读出来的是正文而不是乱码', () => {
    const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xa2, 0xca, 0xcd, 0x0a])
    expect(textCodec.decode(gbk)).toEqual({ content: '中文注释\n', encoding: 'gb18030' })
    expect(textCodec.encode('中文注释\n', 'gb18030')).toEqual(gbk)
  })

  test('BOM 不进正文，写回时按编码补上', () => {
    for (const [encoding, bom] of [['utf8-bom', [0xef, 0xbb, 0xbf]], ['utf16le', [0xff, 0xfe]], ['utf16be', [0xfe, 0xff]]] as const) {
      const bytes = textCodec.encode('x', encoding)
      expect([...bytes.subarray(0, bom.length)]).toEqual([...bom])
      expect(textCodec.decode(bytes)?.content).toBe('x')
    }
  })

  test('编码名核对只认七种', () => {
    for (const encoding of TextEncodings) expect(textCodec.isEncoding(encoding)).toBe(true)
    for (const value of ['utf-8', 'gbk', 'binary', '', 7, undefined, null]) expect(textCodec.isEncoding(value)).toBe(false)
  })
})

describe('按原字节保留编码', () => {
  test('差异太大时退回按前后缀对齐，时间有上限，两头的别名字节仍然留下', () => {
    const before = `€${'a'.repeat(120000)}龴`
    const after = `€${'b'.repeat(120000)}龴`
    const bytes = Buffer.concat([Buffer.from([0x80]), Buffer.from('a'.repeat(120000)), Buffer.from([0xfe, 0x59])])
    const started = Date.now()
    const output = textCodec.encodePreserving(bytes, before, after, 'gb18030')
    expect(Date.now() - started).toBeLessThan(2000)
    expect(output[0]).toBe(0x80)
    expect(output.subarray(-2)).toEqual(Buffer.from([0xfe, 0x59]))
    expect(textCodec.decode(output)?.content).toBe(after)
  })

  test('没改时原样返回原字节；GB18030 以外的编码等同重新编码', () => {
    const original = textCodec.encode('same\r\n', 'utf16le')
    expect(textCodec.encodePreserving(original, 'same\r\n', 'same\r\n', 'utf16le')).toEqual(original)
    expect(textCodec.encodePreserving(original, 'same\r\n', 'changed\r\n', 'utf16le')).toEqual(textCodec.encode('changed\r\n', 'utf16le'))
  })

  test('改动的片段写不成 GB18030 时抛 lossy', () => {
    const original = textCodec.encode('中文', 'gb18030')
    expect(() => textCodec.encodePreserving(original, '中文', '中\uD800文', 'gb18030')).toThrow(expect.objectContaining({ code: TextFileErrorCodes.lossy }))
  })
})
