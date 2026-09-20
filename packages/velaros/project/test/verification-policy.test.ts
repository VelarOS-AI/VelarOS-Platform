/**
 * 验证判据（`projectVerificationPolicy`）：改到哪些文件之后值得再跑一次验证。宿主把它交给 agent 的编码会话，
 * 源码、构建清单、依赖锁与配置格式算，图片、文档、日志不算；相对路径、绝对路径、Windows 写法与大小写变体都认。
 */

import { describe, expect, test } from 'bun:test'

import { projectVerificationPolicy } from '../index'

describe('验证判据', () => {
  test('源码、构建清单、依赖锁与配置格式的改动要再验证', () => {
    for (const path of [
      'src/app.ts', 'src/view.TSX', '/repo/lib/util.py', 'C:\\repo\\src\\main.rs', 'styles/site.scss', 'config/app.yaml',
      'package.json', 'bun.lock', 'Dockerfile', 'Makefile', 'go.sum', '.env', '.gitignore', 'packages/app/tsconfig.json', 'vite.config.ts',
    ]) {
      expect({ path, relevant: projectVerificationPolicy.isVerificationRelevantPath(path) }).toEqual({ path, relevant: true })
    }
  })

  test('图片、文档、日志与认不出的路径不算，免得为纯资源改动重复催验证', () => {
    for (const path of ['docs/guide.md', 'assets/logo.png', 'build.log', 'notes.txt', 'LICENSE', 'src/', '', '///', '.env.local.bak']) {
      expect({ path, relevant: projectVerificationPolicy.isVerificationRelevantPath(path) }).toEqual({ path, relevant: false })
    }
  })
})
