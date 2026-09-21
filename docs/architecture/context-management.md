# ScriptAct 分区工作内存

状态：正式 Platform 实现。主任务、搜索与业务子 Agent 使用同一个 ContextMemory 组装器、ContextStorage、ScriptAct、Agent Loop 和 ProviderRequestCompiler。宿主通过分区配额和近期窗口配置上下文，模型通过代码维护工作笔记与材料可见性。

## 五个分区

每个请求的 runtime-view 材料是一份不可变快照：

```text
schemaVersion / id / frameId
partitions.task          用户目标、输入意图、文件引用
partitions.workspace     任务 capsule、当前驻留笔记及目录入口
partitions.observation   观察源码、本轮输出、版本与采集时间
partitions.recent        有效租约结果、有序响应/结果、检查点和目录
partitions.runtime       作用域、回执、作业、证据、进度与变化
memoryStatus             分区占用、材料进出、配额和整理建议
```

编译器另外加入宿主指令、ScriptAct 协议、当前阶段和 ContextStatus。内部 JSON 用于审计和投递确认；ContextMemory 的唯一文本渲染器将笔记、观察代码和输出排成可读正文。近期响应与结果使用有序 user/assistant 消息，正文在历史与当前文本之间只发送一份。结果对应的源码仍保留，失败编辑的完整候选不能只靠上轮的 edits 还原。图片沿用原生图像块、存储引用与最终附件容量校验。

每轮都重新组装需要发送的内容。增量记录保存在磁盘上，驻留的模型笔记在新帧中继续可见；observe 每个正常业务轮刷新。历史脚本的出现和引用读取均不触发重跑。

## 工作区操作

模型显式在 execute 中维护当前会话的笔记：

```js
import {memory} from 'velaros:system';
const {update, list, read} = memory;
const note = await update({
  key: 'auth-investigation',
  baseRevision: 0,
  title: '登录调查进展',
  body: '已定位退出入口；缓存恢复可能重新写入状态，尚未验证。下一步读取恢复函数。',
  sources: []
});
if (!note.key || note.revision === undefined) throw new Error('缺少笔记版本');
await update({key: note.key, baseRevision: note.revision, body: '已经验证缓存分支；下一步检查调用顺序。'});
```

新建使用 baseRevision:0，已有键必须携带当前 revision。更新返回 key/revision/title/ref/resident/chars；通过同一存储 CAS 追加不可变版本，竞争修改只有一个可以成功，陈旧版本返回 WORKSPACE_CONFLICT。

`update({key,baseRevision,resident:false})` 移出工作内存；`resident:true` 重新申请驻留。正文可以省略以沿用前版。驻留表示持续参与当前会话的组装，实际是否内联取决于容量。笔记跨运行和进程重启保存，直至模型修改驻留状态或宿主执行存储回收。

`list({kind:'notes',after?,through?,limit?})` 分页返回当前笔记版本和原文引用，也包含已移出的笔记；默认 32、最多 64 条，after 是记录序号的排他下界，through 固定目录结束范围。`read({ref,offset?,limit?})` 读取不可变版本的 JSON 归档，单位 UTF-16 字符，最多 60000；旧版本也可读取，读取不自动驻留、不修改版本。

正文最多 60000 字符，标题最多 200 字符，来源最多 64 个；当前授权代次最多 256 个稳定键。模型可以复用键整理内容，原始版本仍在同一对象存储中。每帧最多展示 64 张工作区卡片，恢复窗口更小时进一步减少，省略数量和 list 入口始终明确。

memory 的笔记属于各 Agent 自己的工作区。业务子 Agent 即使没有世界操作模块，也可维护自己的笔记；宿主统一授权钩子仍生效。引用不能跨会话。观察模式可以读取，但所有笔记修改都由 Kernel 限制为 execute-only。

## 来源与事实

工作笔记明确标为 model-note；task capsule 同样是模型认识。用户原文、模型解释、真实来源和 Kernel 回执保留各自身份。

sources 只能引用当前会话已有、当前授权代次内的记录。笔记保存可获得的来源版本戳；本轮 readSet 对同一资源出现不同版本或内容哈希时，笔记标为 changed。没有本轮核验依据时标为 unverified；它不承诺语义结论正确，也不自动扫描任意笔记正文中的文件名。模型应按引用核查并更新认识。

搜索的来源/权限变化触发历史重置时，旧笔记、旧检查点和旧自由历史一起退出活动投影；旧笔记引用不能通过 memory.read 绕回。重新获取授权证据后可以建立新笔记。持久对象保留和当前读取权限分别管理。

## 用户输入与文件

`session.submit({text,files,images})` 继续接受用户输入。原文先持久化；单对象超过 8000000 UTF-16 字符时分块保存，readInput 按逻辑位置跨块读取。文件以当前会话引用、名称、媒体类型和大小进入请求；图片独立归档和编码。

超大文本首次以有界摘录、遗漏范围和原文引用展示。主模型声明下一阶段工作意图，整理支线读取原文后提出版本绑定的输入摘要；Runtime 复用 summarizeInput 校验并发布意图投影。它带有 model-interpretation 来源，原始 user 记录不可变，新用户输入独立追加。摘要及引用不能证明全文已读或理解无误。

## 观察与近期材料

ProgramContext 继续负责不可变源码版本、观察指针和结果租约。observe 每个正常业务轮只读执行；execute 显式执行一次。源码变化与实际输出变化由 diff 报告提供，逐块另外记录内容和展示变化，diff 用于说明变化，当前正文独立发送。命名输出通过 output(value, options) 声明用途、类型和 view；整理工具只修改源码中的展示规则，并用本轮已归档数据重新组装。详细契约见 [声明式观察输出](script-output-observation.md)。

`execute({retain:2})` 为有限业务曝光次数；retain:'task' 到逻辑任务结束或显式释放。主任务默认 2，搜索默认 task。memory.retain 重设期限，memory.release 移出自动投影，memory.read 只读归档。只有成功业务响应所对应帧中实际包含正文的相同租约才消费一次；引用帧、失败、修复和维护轮不消费。后台晚到结果和新续租不能被旧帧消费。

RecentContext 是同一组装器的近期材料组件。它按 sequence 选择有序响应和结果，自动投影排除新格式的 observe 结果。memory.list/read 可以发现和召回原文，整理服务通过 RecentContext.checkpoint 将已完成的旧区间整理为摘要、证据引用、未解问题和否定尝试；仍保留最近两个响应的执行关系。目录与检查点均使用现有 CAS 和授权边界。

超出近期窗口的部分附目录范围；较大响应可以退为引用。过大的检查点在恢复投影中也使用引用卡片，保留原文位置和未解项数量。近期窗口为 0 时有效租约结果仍直接进入 recent 分区，已有检查点仍可作为摘要或引用展示。

## 容量、变化与冻结

宿主可配置：

```js
context: {
  sources: [],
  memory: {recentRecords: 8, workspaceShare: 0.2, recentShare: 0.2}
}
```

搜索在 search.memory 配置，缺省 recentRecords:64、recentShare:0.4；业务子任务在 profile.memory 配置。workspaceShare 范围 0.05–0.5，recentShare 范围 0–0.5，总和最多 0.8，近期窗口为 0–64。

份额约束可裁剪正文，空闲工作区容量会留给其他材料；卡片数量也随恢复窗口缩小。必要回执、用户目标和运行状态仍保留，最终消息及全部图片由 ProviderRequestCompiler 做总预算检查，分区字符计量不能代替最终 token 计量。

memoryStatus 报告各区 UTF-16 序列化占用，以及材料新增、版本更新、退出、仅引用。源码和观察正文的实质差异仍在 runtime.progress 中。变化基线只在本轮响应完整成功后推进，容量重编译不会消费租约。已发出的帧不因之后的笔记更新被改写。

programFrame.resultsRevision 固定组帧时的新结果代次。完成检查用它识别请求发出后新进入租约集合的结果并补投递；同一帧中因预算省略的旧结果不会触发无限刷新。已有结果续租仍由 leaseId 保护曝光次数，不额外触发一轮消费。

ContextStatus 每轮报告 mode:partitioned、阶段、总输入估计、估计依据、窗口、输出/安全预留、剩余额度和整理建议。默认预警 0.75、维护 0.8，单次组帧最多 3 次独立整理尝试，Provider 容量修复最多 2 次。

主线与业务子任务在安全轮边界调用独立 ContextMaintenance 模型工具。它持有固定父快照和分页材料读取能力，通过同一个 ScriptAct/RuntimeSession 提交 ContextPatch。Runtime 校验版本、保护引用和输入基线，复用既有机制，最后一次 CAS 发布全部元数据。笔记展示使用 ref/summary/resident，绑定不可变主笔记版本；整理不会改写主笔记正文或计划。补丁还支持用户意图、历史检查点、结果展示租约和观察输出呈现量。observe 源码由业务模型维护，下一业务轮照常运行新观察。

整理期间新输入或业务结果改变快照时，旧补丁不能发布；预算记账和租约心跳不会制造材料冲突。每次整理预留最后交付轮，收尾要求输出已有信息及未查明事项。搜索与整理本身是叶子工具：容量压力触发引用降级和最后交付阶段。

`memory.organize({focus?,preserve?})` 返回 scheduled 和持久 requestId，下一请求边界由 Runtime 处理。实际结果在下一帧 memoryStatus.maintenance.lastAttempt 自动反馈，包括变更、保留引用、未解项和错误。总预算由 Runtime 决定。该操作只进入具备整理能力的主线和业务子任务合同。`velaros:context-materials.list/read` 只注入活动整理会话。

整理结束后重新执行 ProviderRequestCompiler，主线以 work 请求继续。此过程不运行业务脚本、不额外运行 observe、不消费父业务租约。失败时报告整理结果并确定性退为引用；基础目标、当前用户图片及必要运行状态仍必须通过最终窗口校验，否则 context_blocked。观察或执行图片若因展示预算退出，其原文引用、是否发送及召回方法随帧报告。

宿主通过 context.maintenance.model 选择独立驱动，省略时同一模型在独立会话工作；context.maintenance.profile 配置完整资源档位。默认 24 次模型调用、100 万 token、20 分钟，其中预留最后交付请求 65536 token/90 秒，资料读取最多 256 次/200 万字符。任务总预算仍从全部祖先总账支付。

## 实现与验证

- ContextMemory：工作笔记、版本 CAS、分区组装、投递变化基线。
- ProgramContext：源码与结果租约、实际观察内容和 diff。
- RecentContext：近期有序记录、检查点、权限代次和目录。
- RuntimeSession：同一组装入口、观察准备、执行和投递确认。
- ContextMaintenance / ContextMaintenanceState：独立整理活动、固定快照、原子补丁与结果回执。
- Context / Kernel / ProviderRequestCompiler：可靠存储、用户原文、事实与权限、预算和最终消息。
- SystemModules：modules/memory 两个系统成员；同一实现按主线与叶子作用域投影真实合同。

验收入口包含 context-memory.test.mjs、context-management.test.mjs、advanced-search.test.mjs 和原有执行/多模态回归。受控驱动验证机制和持久性；模型整理笔记、摘要与检索的实际质量仍需真实 Provider 评估。

## 宿主长期记忆

`velaros:system.memory` 将任务工作记忆与宿主长期记忆统一为一个模型入口。工作笔记仍由 update/list/read 管理，长期库通过 recall/save/remove 访问既有 MemoryScopePort。主线按需 output 召回内容，沿用已有结果归档、租约和分区预算；observe 中的 recall 每轮重新读取。长期 Markdown 文件独立于任务租约，整理和 release 只改变任务展示。宿主决定共享范围，搜索、整理和业务子任务的合同不继承长期记忆操作。
