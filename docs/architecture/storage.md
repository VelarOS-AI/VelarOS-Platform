# 存储适配规范

Platform 的主运行状态通过 `ContextStorage` 注入，共享对象与持久消息通过其 `stores: StoreStorage` 成员注入。两者是领域存储端口，公开签名只包含数据与异步方法。默认实现是 `@velaros-ai/context/node` 的 `localContextStorage`。新的数据库实现遵守同一份合同，Agent Loop、ScriptAct、上下文分区、权限和模型工具继续使用原链路。

## 接入与所有权

```ts
import type { ContextStorage } from '@velaros-ai/context';
import { createRuntime } from '@velaros-ai/velaros';

// storage 是宿主已经打开的适配器，底层可以是独立连接或连接池租约。
async function start(storage: ContextStorage) {
  return createRuntime({
    workspace: '/work/project',
    dataDir: '/work/runtime-data',
    storage,
  });
}
```

成功创建后，Runtime 负责在会话、子任务、模块停止后调用 `storage.close()`；创建失败时，宿主仍拥有传入的适配器。多个 Runtime 应各持有一个连接或池租约。适配器的 `close` 幂等，取消本连接的等待并释放资源；池租约的释放不能关闭其他 Runtime 的连接。

省略 `storage` 时，`dataDir` 必填，框架创建 `context.sqlite`。传入适配器时不会创建该数据库；`dataDir` 仍用于默认长期记忆和项目事务恢复文件。SQLite 内置模块只在创建本地适配器时加载，禁用该内置模块不影响其他适配器接入。

## 两个端口分别保存什么

| 端口 | 数据与操作 | 必须保持的语义 |
| --- | --- | --- |
| `ContextStorage.put/get` | 用户原文、脚本版本、观察与执行材料、模型请求/响应、调用日志正文 | 正文不可变，按会话隔离；成功返回前持久化，ID 对上层不透明 |
| `ContextStorage.load/compareAndSwap` | 记录目录、任务状态、工作集、租约、任务 store 引用 | 一致快照；跨实例 CAS；记录和状态一起提交；禁止发布不存在的正文 |
| `ContextStorage.selectSnapshot` | 可选的元数据与指定记录一致快照 | 同一读事务选择记录并返回元数据版本；选择字段取交集、多选择取并集、身份去重后按序号升序；latest 按每个选择取最新项 |
| `ContextStorage.loadMetadata/compareAndSwapMetadata` | 可选的元数据快照与增量 CAS | 保留历史目录；元数据及追加目录项同事务提交；与完整 CAS、appendRecord 共用版本；存储分配递增序号 |
| `ContextStorage.appendRecord` | 可选的单条原子追加 | 事务内验证正文和同会话来源、分配递增序号、推进状态版本；保留其他元数据；重复身份拒绝；失败整体回滚 |
| `ContextStorage.records` | 有序记录分页、精确 title/refId 过滤 | 可选优化；行为等价于从完整状态查询，after 为排他序号 |
| `ContextStorage.collect` | 显式孤立正文回收 | 可选；版本核对、写入宽限期、默认预演；保留所有记录引用的正文 |
| `StoreStorage` | 空间目录、JSON 对象、墓碑、变更流、消息、订阅、处理确认、幂等回执 | 对象更新、序号、附带消息及回执同一原子提交；跨实例可见且可恢复 |

`stores` 可选；需要完整共享能力的适配器实现它。省略时模型不能发现共享 store 能力；主运行时仍可保存脚本、输入、任务和上下文。不能悄悄给缺失的 `stores` 再装配另一份默认数据库。

## 后端实现要求

1. **异步 IO 与原子性。** 全部公开方法返回 Promise。并发修改相同会话版本只能有一个 CAS 成功，失败返回 false；IO 错误抛出。不能把一次读和一次无条件写伪装成 CAS。返回的 JSON 快照和调用者传入的对象都不能与存储共享可变内存。

   `appendRecord` 是可选优化：调用方先完成 `put`，适配器在一次写事务中验证 `objectId` 与 `sources`，分配大于当前最大 sequence 的序号，并把会话 version 加一。已有工作集、任务、摘要等元数据全部保留；并发旧 CAS 必须失败。SessionContext 在端口缺失时走完整 CAS。SQLite 使用索引定位末尾与来源，追加不读取整个记录目录；普通 `load/compareAndSwap` 仍提供完整快照。
   `loadMetadata` 返回不含 records 的独立 `ContextMetadata` 快照。`compareAndSwapMetadata` 保留历史目录，原子替换元数据并追加可选目录项；新版本必须为 expectedVersion + 1，拒绝完整 records 字段、重复记录身份和缺失的非空正文引用。任务归档正文先 put，归档目录和新任务一起提交，失败整体回滚。两个方法成对可用时，任务续租、预算和用量走小快照；调用索引同时需要 records 精确查询。缺少扩展时继续完整 CAS。所有提交共用版本序列，不能用缓存跳过并发核对。日志索引的空 objectId 仍表示无正文索引项。
   `selectSnapshot` 返回 `{metadata, records}`，记录只是所选目录，不能作为完整 CAS 的替换目录。选择支持 title、字面 titlePrefix/titleSuffix、refId、kind、精确 sequence、after 排他下界、through 包含上界、latest、first、last 与 latestPerTitle；筛选后再取最前/最后 N 项或每个标题的最大序号。after/through 为非负安全整数，first 为 1–recordPage 的整数且不与 latest/last/latestPerTitle 合用。last 为 1–recordPage 的整数，sequence 为正安全整数，latestPerTitle 不与 latest/last 合用，latest 不与 last 合用；非法组合抛 INVALID_RANGE。前后缀按 UTF-8 字节字面比较，空后缀匹配所有标题，通配符和 NUL 不改变匹配规则。空选择返回元数据和空目录，不存在的会话返回 null。SQLite 用一个读事务固定元数据与各组查询的版本，添加按 kind 的表达式索引；首次打开旧库会建立该索引。读取期间其他连接提交不能导致结果混合两个版本。消费方提交使用同一 metadata.version；需要多次选择时必须核对版本并在变化后重新读取。
2. **正文先提交。** `put` 返回时对象已经可以被同一存储的其他连接读取。CAS 失败可以留下孤立对象，由显式回收处理。`objectId` 是不透明字符串；日志索引允许用空字符串表示只有元数据的记录，有正文的记录必须验证对象存在。
3. **幂等身份。** 创建空间、写对象、发消息、订阅和处理确认保存原调用身份与回执。同一身份与同一请求恢复原结果；同一身份换请求拒绝。对象更新与附带消息不能分别提交，否则断线恢复会产生重复通知或半个状态。
4. **两个原子边界。** 会话状态 CAS 和 store 提交各自原子；不承诺两者之间有全局事务。调用 journal 在派发前登记意图，响应丢失后按 operationId 查询 store 回执。写入返回不明时继续使用当前核对链，不能重放整段脚本。
5. **消费语义。** 对象 revision、对象变更 sequence、消息 sequence 分别单调。删除保留墓碑。投递游标不等于业务处理确认；旧订阅代次不能确认新订阅。目录先按 scope/owner/grant 过滤，再分页；前缀按字面匹配。保留窗口外必须报告 gap。
6. **通知与关闭。** 等待依据持久序号，通知只负责唤醒。可以使用数据库通知、轮询或两者结合，但必须覆盖注册期间竞态、跨实例写入与取消。关闭应立即结束两个 wait 方法，不能留下轮询任务。
7. **权限仍在调用链。** 模型只访问 `velaros:system.store`；StoreSession/Kernel 负责当前授权与会话身份，适配器负责合同规定的目录和消息过滤。数据库连接和管理 API 不暴露给模型。

## 替换与迁移

实现新适配器时，先运行 `packages/context/test/support/storage-contract.mjs` 的 `storageContract(name, fixture)` 与 `storeContract(name, fixture)`。fixture 提供连接到同一数据集的 `open()`，每次返回独立连接；具体后端另加事务中途故障、断线、进程崩溃和重启持久性测试。当前 SQLite 的底层故障注入用例在 `storage-index.test.mjs`、`store.test.mjs`。

端口边界还由禁用 `node:sqlite` 的正式 Runtime 测试验证：确定性模型输出真实 ScriptAct，Project 修改文件，下一轮观察看到新值，保存 trace 后关闭并重开会话。该测试使用无索引、非哈希 ID 的异步内存替身；它验证耦合边界，不提供生产持久性证明。

已有数据迁移由宿主停写后完成：保持会话/引用/空间身份、版本、序号、墓碑、订阅游标与所有幂等回执；核对数量、引用和正文完整性后切换 `storage`。`collect` 不执行迁移。新会话用 `objectReferencesVersion: 1` 声明持久正文引用全部登记在标准 ContextRecord；缺少标记的旧会话回收和预演均以 CONTEXT_REFERENCES_UNVERIFIED 拒绝。拥有旧业务 schema 的 Runtime 先核验自己的段底座/冻结正文并补齐精确对象 ID 的正式记录，在同一 CAS 中写入标记，再允许回收。通用存储不扫描业务 JSON 猜测引用。新后端的导入导出属于该适配器的管理面，不能通过重放业务脚本迁移。

本轮交付 SQLite 适配器和替换合同；PostgreSQL、远端服务及其迁移器需各自实现并通过上述验收。长期记忆目录、项目事务文件、业务工作区文件及远端凭据各有领域端口；替换 ContextStorage 只改变这份合同覆盖的数据。
