# Act 模型自管理空间

正式入口为 `velaros:system`，按当前会话授权导出 `modules`、`memory` 和 `store`。实际操作、schema 和模板见 [Act 目录](../../packages/velaros/act/README.md)。

## 职责与装配

主模型维护 observe 代码、自己的笔记和计划，并声明下一阶段需要什么。整理模型读取固定父快照，提出派生展示补丁。Runtime 决定预算、调度、权限、版本检查和发布时机。宿主配置模型、资源档位、业务权限和生命周期。

系统能力集中在 `packages/velaros/act/system/`。MemoryModule、ModulesModule、StoreModule 定义操作；SystemModules 负责可信身份；SystemCatalog 返回当前会话的真实包投影。RuntimeSession、ContextMemory、ProgramContext、RecentContext 继续承担执行、存储和组帧机制。StoreSession 固定共享对象的访问范围，持久对象与变更记录通过同一 ContextStorage.stores 持久化；默认适配器使用 SQLite，替换约束见 [存储规范](storage.md)。

| 会话 | 系统面 | 可委托模型工具 |
| --- | --- | --- |
| 主线 | modules；memory 五个本地操作，按配置增加 organize 和 recall/save/remove；store 按授权装配 | 按宿主配置搜索、整理、业务子任务 |
| 业务子任务 | modules；memory 六个操作；store 通过派发显式获配 | 按宿主配置搜索、整理 |
| 搜索 | modules；memory 五个本地操作 | 完成搜索职责 |
| 整理 | context-materials.list/read；ScriptAct output | 完成展示补丁交付 |

未启用整理的主线或业务子任务也使用五操作的本地合同。没有获配的能力同时不进入发现、模板、类型声明和执行绑定。主线与本地记忆使用同一个 MemoryModule 实现，仅合同投影不同。

## 模型 API

| 操作 | 作用 |
| --- | --- |
| modules.list / search | 按 space 和关键词查询真实包目录，授权过滤后分页 |
| modules.describe | 查看指定包或 system 成员的 schema、声明和模板 |
| memory.list | 以 kind/query/after/through/limit 发现归档；kind 为 all、notes、inputs、programs、results、history、artifacts |
| memory.read | 按 ref/offset/limit 读取原文；ref 支持当前会话短 ID 或完整 ContextRef |
| memory.update | 以 key/baseRevision 更新自己的笔记；以 plan 更新当前任务认识 |
| memory.retain / release | 控制当前笔记或执行结果的自动展示；原文可召回 |
| memory.recall | 主线按 id 或 query 召回长期记忆正文，offset/limit 分页；作用域由宿主固定 |
| memory.save / remove | 主线显式保存或删除跨会话长期记忆；save 同 id 整条覆盖，tags 省略沿用 |
| memory.organize | 声明 focus/preserve；返回持久 requestId 和 scheduled，实际结果在下一模型帧自动反馈 |
| store.create / list | 创建独立空间，或分页发现获配空间和权限 |
| store.keys / get | 按空间列出对象目录，或读取当前对象与版本 |
| store.set / remove | 按 baseRevision 完整替换对象或写入删除墓碑 |
| store.events / read | 按订阅读取消息目录，或读取获准的共享材料正文 |
| store.subscribe / ack | 持久登记订阅，并按投递身份确认已处理消息 |
| store.publish / share | 发布独立消息，或把会话材料保存为可共享引用 |
| store.watch | 替换当前会话的持久关注集合；变化随下一模型帧交付 |

list/read/recall 无写效果，可用于观察。update/retain/release/organize/save/remove 只在 execute 调用。结果 retain 的 turns 为 1–32 或 task；笔记保持驻留直到显式释放。驻留不等于全文必定装入窗口。

所有材料读取保持当前会话、逻辑任务及搜索授权代次边界。用户输入通过已有分块 readInput 读取；任务 artifact 使用原 readArtifact 权限检查；源码、结果、笔记及诊断引用使用同一存储的有界读取。调用不重跑原脚本。

## 原始调用与返回

模板统一通过模块目录按需读取；返回的声明和模板来自当前会话的实际授权模块：

```js
import {output} from 'velaros';
import {modules} from 'velaros:system';
const info = await modules.describe({module: 'velaros:system', export: 'memory'});
output(info.template);
```

业务模块使用相同的 `modules.describe({module: 'velaros:files'})`。模板是示例源码，由模型按任务选用和修改，读取时只返回文本。

脚本中的实际用法：

```js
import {output} from 'velaros';
import {memory} from 'velaros:system';
const note = await memory.update({
  key: 'progress', baseRevision: 0,
  body: '已定位登录恢复入口，下一步运行失败测试。'
});
if (!note.ref) throw new Error('缺少笔记引用');
output(await memory.organize({
  focus: '运行登录测试，保留用户约束和当前调查结论',
  preserve: [note.ref]
}));
```

organize 的输入合同是 `{focus?:string,preserve?:ContextRef[]}`；窗口大小由 Runtime 从当前请求预算决定。preserve 保持引用可召回，并禁止整理释放指定结果租约或主动移出指定笔记；它不承诺绕过总窗口限制全文驻留。

返回形状：

```json
{
  "requestId": "<持久 UUID>",
  "taskId": "<当前逻辑任务 ID>",
  "status": "scheduled",
  "focus": "运行登录测试，保留用户约束和当前调查结论",
  "preserve": [{"sessionId":"<当前会话>","id":"<笔记版本 ID>"}],
  "boundary": "next-model-request"
}
```

这不是处理成功回执。同一边界多个请求通过 CAS 合并，使用同一 requestId，保留引用取并集，后一次明确 focus 更新意图。认领也使用 CAS，后台新请求不会被旧请求的认领覆盖。

下一帧的 `memoryStatus.maintenance.lastAttempt` 包含 requestId、status、focus、changes、preserved、unresolved、error、report 和回执 ref；当前策略提供 summary、maxChars、active 等信息。详细报告仍通过 memory.read 召回。模型无需轮询状态。

同一响应内 organize 后输出 done 时，完成检查先补投递新帧，等主模型看过真实整理结果后再处理完成声明。新逻辑任务不会消费旧任务的请求。

## 整理发布

整理支线用 context-materials.list/read 读取固定父快照，通过 execute 中的 output(patch) 交付结构化补丁。notes 项只允许 `{ref,summary?,resident?}`。ref 绑定当前不可变笔记版本；派生摘要标注 model-interpretation，主模型改写原笔记后该摘要自动失效。

输入摘要保留已确认约束；历史检查点保留来源和未解事项；观察补丁只修改已认可的输出展示 AST 元数据并重投影已有结果。主模型的笔记正文、任务计划以及原始用户输入保持各自归属。

ContextMaintenanceState 在临时事务视图里组装完整候选五区及图片，检查必需内容、保护引用和版本，并使用父 ProviderRequestCompiler 计量；最后 CAS 一次发布。取消、冲突或预算失败不发布候选。Runtime 回传失败和缺口，再按现有策略降级或阻塞。

## 包投影与真实调用链

主线映射为：

```json
{"specifier":"velaros:system","exports":{"modules":"velaros:modules","memory":"velaros:system-memory","store":"velaros:system-store"}}
```

本地合同的 memory 映射到 `velaros:system-memory-local`。主线装配长期记忆后映射到 `velaros:system-memory-persistent`。三种投影均由同一个 MemoryModule 实现，模型只使用 `velaros:system.memory`。搜索、整理和业务子任务不继承宿主的长期记忆端口。store 的可写投影为 `velaros:system-store-write`，只读投影为 `velaros:system-store-read`，实际分别提供十二项和十项操作；声明、模板和发现共用这份投影。

实际链路：ScriptAct 完整响应预检，KernelScriptSession 使用当前包投影检查脚本，隔离执行器调用 KernelInvocationPort，Kernel 校验 schema、模式、权限和绑定代次，MemoryModule 调用现有 ContextMemory、整理服务或长期 MemoryScopePort，调用回执持久化，下一请求由 Runtime 组帧。

output 在 `velaros`，input/blobs 在 `velaros:program`。绑定释放、权限调整、完整运行诊断与恢复由宿主生命周期负责。

## 合同与验证

当前系统合同代际为 20，Runtime 合同代际为 16；实际值由各自 contract/constants.ts 维护。系统操作统一从 memory/modules/store 成员访问，持久原文通过 memory.read 读取。

共享状态的具体文件、接口与验证见 [共享状态差量报告](../engineering/act-store-delta.md)。

## 长期记忆与工作记忆

宿主实例资源接入：

```ts
const store = createMemoryStore({root: '/absolute/path/to/memory'});
const runtime = await createRuntime({
  storage, runner, modules, model,
  memory: sessionId => store.scope(hostScopeFor(sessionId))
});
```

同作用域的主会话共享长期记忆，不同作用域按原目录规则隔离；主会话打开时固定端口，模型参数不包含 scope。`memory.update` 维护任务笔记；`memory.save` 明确选择值得跨会话保存的内容。召回保持原库按更新时间排序，query 对 id、标题、描述、标签和正文进行大小写不敏感的字面匹配。`recall({})` 默认最多 8 条，每页最多 32 条；返回 `{items,total,nextOffset}`，items 含完整 MemoryEntry。它不做语义搜索或事实验证。

长期库不会自动全文进入请求。主模型可在 execute 中按需召回并 output，结果通过既有租约回收；需要持续查看时可将 recall 放入 observe。整理工具可以整理已召回材料的展示，长期库的原文需要主线显式 save/remove 才会改变。支线需要某条记忆时，由主线将已召回材料显式分享。

## 持久 store 与共享

store 是一组持久 JSON 对象、访问授权和变更订阅。Agent 可以使用多个 store，一个 store 可以被多个获准 Agent 使用。空间以不可变 id 标识，名称只用于理解用途；创建时自动保存，关闭脚本、回收上下文和结束任务都不删除对象。

模型的唯一入口是 `import {store} from 'velaros:system'`：

| 操作 | 输入 | 返回 |
| --- | --- | --- |
| create | `{name,description?}` | 空间描述及 access，包含稳定 id |
| list | `{active?,after?,limit?}` | 获配空间的 `{items,nextAfter}` |
| keys | `{store,prefix?,after?,limit?}` | 对象元数据的 `{items,nextAfter}` |
| get | `{store,key}` | 当前对象，或未创建时的 null |
| set | `{store,key,baseRevision,value,event?}` | 提交后的对象 |
| remove | `{store,key,baseRevision}` | 删除墓碑，保留递增版本 |
| watch | `{store,keys?,prefixes?}` | 该空间订阅的 `{revision,after,keys,prefixes}` |

get/list/keys/events/read 可用于 observe；create/set/remove/watch/subscribe/ack/publish/share 只在 execute。set 是完整替换，创建新键的 baseRevision 为 0，后续更新使用 get 返回的 revision。写冲突需要重新读取判断，相同版本写入相同值不制造新变化。get 和写回回执按 `[storeId,key]` 校验依据，不会混淆不同空间的同名对象。

execute 示例：

```js
import {output} from 'velaros';
import {store} from 'velaros:system';
const work = await store.create({name:'登录改造',description:'共享调查、实现和验证信息'});
await store.set({store:work.id,key:'plan',baseRevision:0,value:{goal:'修复登录恢复',status:'investigating'}});
await store.watch({store:work.id,prefixes:['findings/','verification/']});
output(work);
```

后续脚本使用返回的实际 id；`store.list` 也能在重建会话后发现它。observe 中调用 `store.get({store:id,key:'plan'})`，通过 output 选择每轮真正需要的正文。

主线通过已有子任务派发显式共享：

```js
import {start} from 'velaros:agents';
const job = await start({
  task:'调查登录状态恢复并将结论写入 findings/',
  profile:'investigator',
  stores:[{store:work.id,read:['plan','findings/'],write:['findings/']}]
});
```

job.stores 持久保存这份授权，resume 时重新检查父范围和宿主 profile。子任务没有创建空间的能力，其写入范围必须包含在读取范围内，并且两者都不能超过父会话的范围。`AgentProfile.stores=false` 可以整体关闭共享。未获配的空间不会进入目录，未共享空间的子任务没有 store 成员；搜索和整理保留专项能力。

宿主配置主线的空间边界及跨主线授权：

```ts
const runtime = await createRuntime({
  storage, runner, modules, model,
  stores: sessionId => ({
    scope: hostProjectId(sessionId),
    create: true,
    grants: hostStoreGrants(sessionId)
  })
});
```

scope 是宿主控制的租户或项目边界，store.id 是该边界内的具体空间。默认 scope 为 `session:<id>`；主线默认拥有自己创建的空间，访问其他创建者的空间需要 grants；针对具体空间的显式 grants 优先，也可收窄拥有者权限。返回 undefined 关闭能力。只给出空间 ID 不构成授权。创建权限和授予范围在打开会话时固定；需要更新授权时重新装配会话。

## 多空间通知与生命周期

对象、空间序号、变化和提交回执经 StoreStorage 原子提交，默认由 SQLite 事务实现；可替换边界见 [存储适配规范](storage.md)。创建空间及其幂等回执也在同一事务内。提交后通过现有通知机制快速唤醒，跨连接读取持久序号补收。创建或写入成功但响应丢失时，Kernel reconcile 根据原调用身份核对，不重跑脚本。

watch 为每个 Agent 在每个 store 中独立保存关注项及确认位置。相同声明保留位置，改变集合从当前提交序号开始，空集合取消。先 watch 再 get/keys 读取基线，避免注册前后的观察空隙。订阅跨任务保持到显式修改。

下一请求的 `partitions.runtime.stores` 包含：

- `active`：当前任务使用或获配的稳定引用，含 taskId、items、total、omitted；每条为 id/name/description/descriptionTruncated。
- `items/nextAfter`：最多四个获配空间的普通目录及权限；更多内容通过 store.list 分页读取。
- `changes`：实际交付的空间变化页，每项含 store、订阅 revision、after/through/head、events、gap、hasMore。

所有空间共用每帧至多八个事件或缺口的预算，每空间每帧至多一个合并对象事件，确认后轮换下一空间起点。每份事件只包含位置、版本、删除标记和写入者，不自动加入对象正文。分区纳入 ProviderRequestCompiler 的真实计量。

完整模型响应被接受后，只确认实际帧覆盖的各空间序号；失败前未确认的通知可再次投递。通知确认表示已交付，业务完成需要另外保存状态。活动运行等待后台脚本或子任务时，任一已关注空间的相关变化可以唤醒下一轮；已结束运行仍由宿主再次 submit。

每对象最多 256 KiB，每个订阅最多 64 个选择项，每空间保留最近 4096 个变化，跨连接等待每 250 ms 检查序号。每个创建者在一个边界内最多 128 个活动空间，归档释放活动额度；每会话最多显式获配 128 个空间。事件缺口通过 gap 报告，正文和墓碑继续保留；JSON 引用仍须通过原材料能力授权读取。

空间生命周期由宿主管理：`storage.stores.archive(scope,id)` 撤回目录和模型访问，原始对象与回执保留。对象删除使用模型 remove，空间归档属于宿主管理。多对象与外部业务操作分别产生回执，不承诺跨操作原子性。

## 存储初始化

新会话的 store 目录由当前宿主边界内的已有空间和显式 grants 决定。没有创建或获配空间时目录为空；模型通过 store.create 获取持久 UUID，再用该 ID 访问对象。会话重启后按相同宿主边界和会话身份恢复目录，订阅由会话身份、store ID 和读写范围共同确定。

LocalContextStorage 使用 store_catalog、store_creations 管理目录与创建回执，store_heads、store_objects、store_changes、store_consumers、store_commits 管理空间数据。目录的 scope 是宿主边界，数据表的 store 是具体空间标识；写入与新订阅要求空间已创建且处于活动状态。

具体改动和验证见 [store 升级差量](../engineering/act-store-delta.md)。

## 当前任务的稳定 store 引用

创建、读取、列出键、写入、删除对象、订阅或向子任务共享空间时，Runtime 自动把 store ID 合并到当前任务的 storeRefs；普通 list 发现目录不激活所有空间。宿主显式 grants 和子任务收到的共享授权也自动参与活跃集合。继续任务和 Runtime 重启保持引用；新逻辑任务重建使用集合，当前获配授权继续可见，持久 store 本身继续存在。

引用通过现有 ContextStorage CAS 与任务检查点保存，包含 ID 而不复制对象正文。每次投影重新获取当前目录并核验边界和授权，再生成 `partitions.runtime.stores.active`。已归档或失去授权的空间不显示；引用不续租 execute 结果，也不代替 observe 读取真实数据。

引用列表最多使用当前投影预算的四分之一，且不超过 8000 字符；用途说明最多显示 160 字符，截断时 descriptionTruncated 为 true。放不下的引用计入 omitted，总数通过 total 明确呈现。模型用 `store.list({active:true,limit:20,after})` 分页找回完整活跃目录和说明。全部内容仍由 ProviderRequestCompiler 计量。

```json
{
  "active": {
    "taskId": "<当前逻辑任务 ID>",
    "items": [{"id":"<store UUID>","name":"登录调查","description":"持续收集登录状态证据","descriptionTruncated":false}],
    "total": 1,
    "omitted": 0
  }
}
```

## 持久协作

store 同时提供结构化对象、逐条事件和共享材料。对象关注与消息订阅分开，投递确认与处理确认分开。子任务通过持久请求与父任务交互，环境更新只在收束后的续跑边界生效。完整 API、原子性范围、运行中及空闲唤醒、恢复和验证见 [协作交付差量](../engineering/act-cooperation-delta.md)。
