# 长期记忆并入系统入口：接入差量

## 完成范围

现有 Markdown 长期记忆库通过 `VelarosRuntimeOptions.memory(sessionId)` 接入正式 Act Runtime。模型统一从 `velaros:system` 导入 `memory`。长期内容的目录、scope 算法、字段校验和原子文件写入复用 `packages/velaros/memory/`；任务材料、笔记、租约、上下文整理复用当前执行链。

## 公开契约与逐项操作差量

- `runtime/contract/requires.ts`：增加可选 `memory(sessionId): MemoryScopePort`，主会话打开时固定宿主返回的作用域端口。
- `system/contract/requires.ts` 与 `system/index.ts`：增加 `LongTermMemoryHost`，公开范围仅有 scope 解析和实际 organizer 配置。
- `MemoryModuleApi.create(host,organize,persistent)`：同一个实现按装配生成当前会话合同。系统合同版本更新为 14；持久记忆投影的 revision 还包含 organize/local，区分实际操作表。
- `memory.recall({id?,query?,offset?,limit?})`：复用原 list 读取，id 精确匹配，query 对 id/标题/描述/标签/正文做字面匹配，默认 8 条、最多 32 条，返回 `{items,total,nextOffset}`。该操作只读，允许 observe/execute。
- `memory.save(input)`：复用原 MemorySaveInput、MemorySaved 和 memoryOperations.save；原库赋予 updatedAt，同 id 整条覆盖，省略 tags 保留原值。仅 execute。
- `memory.remove({id})`：复用原删除操作和回执，删除磁盘原文；本来没有时 `removed:false`。仅 execute。
- list/read/update/retain/release/organize 的任务语义保持原约定。长期库与任务展示的生命周期分别由 save/remove 和 retain/release 控制。

原有验收承诺继续生效，新增 INV-12 覆盖长期记忆整合。新测试纳入 Velaros 常规 test 入口。

## 实际文件与执行链

`ComposedRuntime` 固定主会话端口、装配长期合同、限制角色能力，并将实际作用域包传给 `RuntimeSession`。`StandardModules` → `SystemModules` → `MemoryModule` → 现有 `memoryOperations` → 宿主 `MemoryScopePort` → Markdown 文件。授权、模式、schema 和操作回执仍由 Kernel 处理。

`SystemCatalog` 返回唯一 system 卡片及 memory 成员的实际合同；`RuntimeSession` 仅给主线注入长期记忆说明。`memory-long-term-template.js` 提供长期 API 用法，主线 describe 返回组合后的完整模板。`scripts/script/act-catalog.mjs` 生成实际投影与模式目录。

搜索、整理及业务子任务均不继承主线长期端口，发现、声明与绑定一致。需要共享某条记忆时，主线先 recall/output，再利用已有材料分享机制交给子任务。整理工具只修改已召回材料的展示，不能修改长期库原文。

## 接入及兼容

```ts
import {createRuntime} from '@velaros-ai/velaros';
import {createMemoryStore} from '@velaros-ai/velaros/memory';

const store=createMemoryStore({root:'/absolute/path/to/memory'});
const runtime=createRuntime({
  storage, runner, modules, model,
  memory:sessionId=>store.scope(hostScopeFor(sessionId))
});
```

宿主定义 hostScopeFor；同 scope 的主会话共享记忆，不同 scope 继续按原目录隔离。现有 Markdown 文件无需转换。原库的宿主入口、索引和独立集成合同继续可用。

Act 宿主原先通过 `modules` 挂载 `velaros:memory` 的，需要改为上述注入口；Runtime 对重复业务入口给出明确迁移错误。原脚本的 `velaros:memory.list/save/remove` 改为 `velaros:system` 的 `memory.recall/save/remove`；recall 为分页对象，数据位于 items。

## 上下文与限制

长期库按需召回，正文由脚本 output 选择，结果进入既有归档、租约和分区预算链。持续观察可放入 observe，每轮重新召回。主线 release/整理不会删除 Markdown。召回内容是历史资料，不构成已经核验的世界事实；使用前需要到真实来源验证。

返回分页控制传给脚本的数据量；现有 `MemoryScopePort.list()` 仍读取当前作用域的全部记忆。query 是字面匹配，不是语义检索。save 沿用既有整条覆盖语义，不提供多进程 CAS；多宿主并发写同一条需由宿主协调。

## 验证

- Act Runtime、system/search/agents 与确定性评测：292 项通过（含新增 9 项长期记忆集成测试）。
- 原长期记忆模块的领域、模板、独立导入与包消费测试：20 项通过。
- 合计 312 项通过；最终合同 revision 区分完成后，9 项集成测试再次通过。
- Velaros 构建与 TypeScript 检查通过；module-ownership、act-catalog、agent-schemas、agent-arch、capabilities-arch 门禁通过。
- 真实模型评测按用户安排留到后续。本轮验证使用正式存储、ScriptAct 执行器、Kernel、权限与上下文编译链，模型输出使用确定性夹具。
