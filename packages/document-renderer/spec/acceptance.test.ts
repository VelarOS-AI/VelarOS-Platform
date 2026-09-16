/**
 * 独立文档渲染器的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 只经根入口，只测对外承诺的行为；真渲染出图的实现测试在 test/renderer.test.ts。
 */

import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test } from 'bun:test'

import { documentRenderer, DocumentRendererProtocol } from '../src/index'

/** 一条回执里的错误部分，用来在断言里取 message。 */
const errorOf = (response: unknown): { code: string; message: string } =>
  (response as { error: { code: string; message: string } }).error

describe('命令协议', () => {
  let temporaryRoot: string | undefined

  afterEach(async () => {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true })
    temporaryRoot = undefined
  })

  test('INV-1 命令行的每一种坏输入都回一条 JSON 回执', async () => {
    const brokenArgument = await documentRenderer.runCli(['--request-json', '{bad'])
    expect(brokenArgument.exitCode).toBe(1)
    expect(JSON.parse(brokenArgument.text)).toMatchObject({
      status: 'error',
      requestId: 'invalid-request',
      error: { code: 'INVALID_REQUEST' },
    })
    expect(errorOf(JSON.parse(brokenArgument.text)).message).toContain('--request-json 的值')

    const missingArgument = await documentRenderer.runCli(['--request-json'])
    expect(missingArgument.exitCode).toBe(1)
    expect(JSON.parse(missingArgument.text)).toMatchObject({
      status: 'error',
      error: { code: 'INVALID_REQUEST' },
    })

    const brokenStandardInput = await documentRenderer.runCli([], 'not json at all')
    expect(brokenStandardInput.exitCode).toBe(1)
    expect(errorOf(JSON.parse(brokenStandardInput.text)).message).toContain('标准输入')

    const described = await documentRenderer.runCli(['describe'])
    expect(described.exitCode).toBe(0)
    expect(described.text.endsWith('\n')).toBe(true)
    expect(JSON.parse(described.text)).toMatchObject({
      status: 'success',
      result: { product: DocumentRendererProtocol.product },
    })
  })

  test('INV-2 三条路径都要落在 projectRoot 内，越界时外面一个目录都不建', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-policy-'))
    const externalRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-external-'))
    try {
      await Bun.write(join(externalRoot, 'outside.pdf'), '%PDF-1.4\n%%EOF\n')
      await Bun.write(join(temporaryRoot, 'inside.pdf'), '%PDF-1.4\n%%EOF\n')
      await symlink(join(externalRoot, 'outside.pdf'), join(temporaryRoot, 'linked.pdf'))
      await symlink(externalRoot, join(temporaryRoot, 'link'))

      const traversal = await documentRenderer.execute({
        protocolVersion: DocumentRendererProtocol.version,
        requestId: 'traversal',
        operation: 'render-pdf-page',
        projectRoot: temporaryRoot,
        inputPath: '../outside.pdf',
        outputPath: 'page.png',
      })
      expect(traversal).toMatchObject({ status: 'error', error: { code: 'PATH_DENIED' } })

      const symlinkEscape = await documentRenderer.execute({
        protocolVersion: DocumentRendererProtocol.version,
        requestId: 'symlink',
        operation: 'render-pdf-page',
        projectRoot: temporaryRoot,
        inputPath: 'linked.pdf',
        outputPath: 'page.png',
      })
      expect(symlinkEscape).toMatchObject({ status: 'error', error: { code: 'PATH_DENIED' } })

      const outputEscape = await documentRenderer.execute({
        protocolVersion: DocumentRendererProtocol.version,
        requestId: 'mkdir-escape',
        operation: 'render-pdf-page',
        projectRoot: temporaryRoot,
        inputPath: 'inside.pdf',
        outputPath: 'link/newdir/deeper/page.png',
      })
      expect(outputEscape).toMatchObject({ status: 'error', error: { code: 'PATH_DENIED' } })
      // 判定在建目录之前：projectRoot 之外一个目录都没被建出来
      expect(await stat(join(externalRoot, 'newdir')).catch(() => null)).toBeNull()
    } finally {
      await rm(externalRoot, { recursive: true, force: true })
    }
  })

  test('INV-3 outputPath 是符号链接时直接拒绝，链接指向的文件一个字节都不动', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-output-'))
    const externalRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-output-external-'))
    try {
      await Bun.write(join(temporaryRoot, 'inside.pdf'), '%PDF-1.4\n%%EOF\n')
      await Bun.write(join(externalRoot, 'outside.png'), 'do not overwrite')
      await symlink(join(externalRoot, 'outside.png'), join(temporaryRoot, 'linked-output.png'))

      const response = await documentRenderer.execute({
        protocolVersion: DocumentRendererProtocol.version,
        requestId: 'output-symlink',
        operation: 'render-pdf-page',
        projectRoot: temporaryRoot,
        inputPath: 'inside.pdf',
        outputPath: 'linked-output.png',
      })

      expect(response).toMatchObject({ status: 'error', error: { code: 'PATH_DENIED' } })
      expect(await readFile(join(externalRoot, 'outside.png'), 'utf8')).toBe('do not overwrite')
    } finally {
      await rm(externalRoot, { recursive: true, force: true })
    }
  })

  test('INV-4 describe 报的版本就是 package.json 的版本', async () => {
    const manifest = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }

    expect(documentRenderer.describe()).toMatchObject({
      protocolVersion: DocumentRendererProtocol.version,
      product: 'velar-document-renderer',
      version: manifest.version,
      transport: 'one-json-request-per-process',
    })

    const response = await documentRenderer.execute({
      protocolVersion: DocumentRendererProtocol.version,
      requestId: 'describe-1',
      operation: 'describe',
    })
    expect(response).toMatchObject({
      status: 'success',
      requestId: 'describe-1',
      result: { version: manifest.version },
    })
  })

  test('INV-5 请求不合法时给的是可读的中文说明，不是 zod 原始 issue', async () => {
    const unknownOperation = await documentRenderer.execute({
      protocolVersion: DocumentRendererProtocol.version,
      requestId: 'bad-operation',
      operation: 'render-everything',
    })

    expect(unknownOperation).toMatchObject({
      status: 'error',
      requestId: 'bad-operation',
      error: {
        code: 'INVALID_REQUEST',
        message: '请求不合法：operation 应为 describe、render-office 或 render-pdf-page',
      },
    })

    const missingFields = await documentRenderer.execute({
      protocolVersion: DocumentRendererProtocol.version,
      requestId: 'missing',
      operation: 'render-office',
    })

    expect(missingFields).toMatchObject({ status: 'error', error: { code: 'INVALID_REQUEST' } })
    expect(errorOf(missingFields).message)
      .toBe('请求不合法：projectRoot 应为字符串；inputPath 应为字符串；outputPath 应为字符串')
    expect(errorOf(missingFields).message).not.toContain('"code"')
  })

  test('INV-6 项目里名叫 ..xxx 的目录不算越界', async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'velar-renderer-dotdot-'))
    await mkdir(join(temporaryRoot, '..cache'), { recursive: true })
    await Bun.write(join(temporaryRoot, '..cache', 'sample.pdf'), '%PDF-1.4\n%%EOF\n')

    const response = await documentRenderer.execute({
      protocolVersion: DocumentRendererProtocol.version,
      requestId: 'dotdot',
      operation: 'render-pdf-page',
      projectRoot: temporaryRoot,
      inputPath: '..cache/sample.pdf',
      outputPath: '..cache/out/page-1.png',
    })

    // 这份 PDF 是占位内容，渲染注定失败；要紧的是它没有被当成越界，输出目录照常建在项目里
    expect(errorOf(response).code).not.toBe('PATH_DENIED')
    expect((await stat(join(temporaryRoot, '..cache', 'out'))).isDirectory()).toBe(true)
  })
})
