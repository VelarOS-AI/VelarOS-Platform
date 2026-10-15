import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ContextLimits, StoreLimits } from '@velaros-ai/context'

import { ContextMaintenanceReadLimits } from '../../../dist/act/runtime/contract/constants.js'
import {
  ContextPatchLimits,
  ExecutionWaitLimits,
  GoalLimits,
  MemoryReadLimits,
  MemoryRecallLimits,
  OrganizeLimits,
  ProgramCatalogLimits,
  ScriptLeaseLimits,
  StoreProjectionLimits,
  SystemCatalogLimits,
  WorkspaceLimits,
} from '../../../dist/act/system/contract/constants.js'
import {
  VelarContextMaterialsModule,
  VelarExecutionsModule,
  VelarModulesModule,
  VelarSystemGoalModule,
  VelarSystemMemoryPersistentModule,
  VelarSystemStoreModule,
} from '../../../dist/act/system/contract/surface.js'
import { VelarProgramsModule } from '../../../dist/act/system/contract/surface.js'
import { contextModule } from '../../../dist/act/system/impl/ContextModule.js'
import {
  memoryModule,
  modulesModule,
  programsModule,
  storeModule,
} from '../../../dist/act/system/index.js'
import { MemoryLimits } from '../../../dist/memory/index.js'
import { verifyModule } from '../../runtime/test/support/module-contract.mjs'
test('INV-1 memory 的实际操作与模板一致', () =>
  verifyModule(memoryModule, new URL('../memory-template.js', import.meta.url)))
test('INV-1 本地 memory 只生成五个实际操作', () =>
  verifyModule(
    { create: (host) => memoryModule.create(host, false) },
    new URL('../memory-local-template.js', import.meta.url)
  ))
test('INV-1 modules 的实际操作与模板一致', () =>
  verifyModule(modulesModule, new URL('../modules-template.js', import.meta.url)))
test('INV-21 programs 的 TS 合同、实际操作、效果与模板一致', () =>
  verifyModule(
    {
      create: (host) =>
        programsModule.create({
          ...host,
          programCatalog: () => {
            throw new Error('definition-only fixture')
          },
        }),
    },
    new URL('../programs-template.js', import.meta.url)
  ))

test('INV-13 store 完整合同与模板一致', () =>
  verifyModule(storeModule, new URL('../store-template.js', import.meta.url)))
test('INV-13 store 只读投影与模板一致', () =>
  verifyModule(
    { create: (host) => storeModule.create(host, 'read') },
    new URL('../store-read-template.js', import.meta.url)
  ))

test('INV-13 store 写入投影与模板一致', () =>
  verifyModule(
    { create: (host) => storeModule.create(host, 'write') },
    new URL('../store-write-template.js', import.meta.url)
  ))

test('整理材料目录和正文使用精确类型，模板可直接通过脚本检查', () =>
  verifyModule(
    { create: (host) => contextModule.create(host)[0] },
    new URL('../context-materials-template.js', import.meta.url)
  ))

import { goalModule } from '../../../dist/act/system/impl/GoalModule.js'
test('INV-19 goal 的实际合同、声明和模板一致', () =>
  verifyModule(goalModule, new URL('../goal-template.js', import.meta.url)))

/** 声明里写给模型的上限逐条对上常量表：改了常量没改文档（或反过来）都在这里失败。 */
const documented = (surface, fragments) => {
  for (const fragment of fragments)
    assert.ok(
      surface.declarations.includes(fragment),
      `${surface.specifier} 的声明里没有「${fragment}」`
    )
}
test('INV-20 声明里写给模型的上限与常量表一致', () => {
  documented(VelarExecutionsModule, [
    `waitMs 为整数毫秒 1..${ExecutionWaitLimits.maxMs}，默认 ${ExecutionWaitLimits.defaultMs}`,
  ])
  assert.equal(VelarExecutionsModule.operations.wait.effects, 'none')
  assert.equal(VelarExecutionsModule.operations.read.effects, 'none')
  assert.equal(VelarExecutionsModule.operations.stop.effects, 'write')
  documented(VelarSystemGoalModule, [
    `objective 最多 ${GoalLimits.objectiveChars} 个字符`,
    `reason 最多 ${GoalLimits.reasonChars} 个字符`,
  ])
  documented(VelarModulesModule, [
    `limit 默认 ${SystemCatalogLimits.page}、最多 ${SystemCatalogLimits.maxPage}。`,
    `1 到 ${SystemCatalogLimits.maxExports} 个`,
  ])
  documented(VelarProgramsModule, [
    `1 到 ${ProgramCatalogLimits.nameChars} 个字符`,
    `1 到 ${ProgramCatalogLimits.purposeChars} 个字符`,
    `最多 ${ProgramCatalogLimits.inputDescriptionChars} 个字符`,
    `limit 默认 ${ProgramCatalogLimits.page}、最多 ${ProgramCatalogLimits.maxPage}`,
  ])
  assert.equal(VelarProgramsModule.operations.publish.effects, 'write')
  assert.deepEqual(VelarProgramsModule.operations.publish.allowedModes, ['execute'])
  assert.equal(VelarProgramsModule.operations.list.effects, 'none')
  assert.equal(VelarProgramsModule.operations.describe.effects, 'none')
  documented(VelarSystemMemoryPersistentModule, [
    `through 固定目录快照的结束序号；limit 每页最多 ${WorkspaceLimits.maxPage} 项`,
    `一页最多 ${ContextLimits.readChars} 个字符。读取不续租`,
    `最多 ${MemoryReadLimits.pointerChars} 个字符`,
    `key 1 到 ${WorkspaceLimits.keyChars} 个字符`,
    `title 最多 ${WorkspaceLimits.titleChars} 个字符，body 最多 ${WorkspaceLimits.bodyChars} 个字符，sources 是它依据的原文引用（最多 ${WorkspaceLimits.sources} 条）`,
    `focus 是接下来要推进的工作（1 到 ${OrganizeLimits.focusChars} 个字符）`,
    `不能释放的原文引用（最多 ${OrganizeLimits.preserve} 条）`,
    `成功业务回合数（1 到 ${ScriptLeaseLimits.maxTurns}）`,
    `limit 默认 ${MemoryRecallLimits.page}、最多 ${MemoryRecallLimits.maxPage}。`,
    `最多 ${MemoryLimits.idChars} 个字符；标题最多 ${MemoryLimits.titleChars} 个字符、描述最多 ${MemoryLimits.descriptionChars} 个字符`,
    `正文最多 ${MemoryLimits.contentChars} 个字符`,
    `最多 ${MemoryLimits.tagCount} 个，每个最多 ${MemoryLimits.tagChars} 个字符`,
  ])
  documented(VelarSystemStoreModule, [
    `只列当前任务在用的空间；limit 每页最多 ${StoreLimits.maxPage} 个`,
    `prefix 限定键前缀（最多 ${StoreLimits.keyChars} 个字符），limit 每页最多 ${StoreLimits.maxPage} 项`,
    `key 最多 ${StoreLimits.keyChars} 个字符`,
    `after 是消息序号，limit 每页最多 ${StoreLimits.maxPage} 条`,
    `limit 默认 ${StoreProjectionLimits.materialChars}、最多 ${StoreProjectionLimits.maxMaterialChars}`,
    `订阅主题前缀（最多 ${StoreLimits.watchItems} 个，每个最多 ${StoreLimits.keyChars} 个字符）`,
    `ids 1 到 ${StoreLimits.maxPage} 个`,
    `两者合计最多 ${StoreLimits.watchItems} 项`,
    `value 的 JSON 最多 ${StoreLimits.messageBytes / 1024} KiB。`,
    `value 的 JSON 最多 ${StoreLimits.valueBytes / 1024} KiB，大材料用 share`,
    `name 最多 ${StoreLimits.nameChars} 个字符（名字不是授权），description 最多 ${StoreLimits.descriptionChars} 个字符`,
  ])
  documented(VelarContextMaterialsModule, [
    `从头翻不给；limit 每页最多 ${ContextMaintenanceReadLimits.maxPageItems} 项`,
    `一页最多 ${ContextMaintenanceReadLimits.maxPageChars} 个字符`,
    `summary（有证据支持的整理说明，1 到 ${ContextPatchLimits.summaryChars} 个字符）与 unresolved（未解决事项，最多 ${ContextPatchLimits.unresolved} 条、每条最多 ${ContextPatchLimits.unresolvedChars} 个字符）`,
    `releaseStoreRefs 各最多 ${ContextPatchLimits.items} 项，整份不超过 ${ContextPatchLimits.patchChars} 个字符`,
    `text 1 到 ${ContextPatchLimits.textChars} 个字符`,
    `summary 写这一段做了什么、查明了什么（1 到 ${ContextPatchLimits.summaryChars} 个字符）`,
    `summary（1 到 ${ContextPatchLimits.textChars} 个字符）与 resident`,
  ])
})
