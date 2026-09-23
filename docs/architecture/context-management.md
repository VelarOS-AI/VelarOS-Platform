# ScriptAct 分区工作内存

状态：正式 Platform 实现。主任务、搜索与业务子 Agent 使用同一个 ContextMemory 组装器、ContextStorage、ScriptAct、Agent Loop 和 ProviderRequestCompiler。宿主通过分区配额和封段保留的近期记录数配置上下文，模型通过代码维护工作笔记与材料可见性。

长程运行的请求布局、段与封段、按剩余轮数触发整理见 [长程上下文](long-running-context.md)。本文的近期材料、容量与整理几节按它的第一、二阶段实现描述。

## 五个分区

每个请求的 runtime-view 材料是一份不可变快照：

```text
schemaVersion / id / frameId
partitions.task          用户目标、输入意图、文件引用
partitions.workspace     任务 capsule、当前驻留笔记及目录入口
partitions.observation   观察源码、本轮输出、版本与采集时间
partitions.recent        有效租约结果的状态与段内历史计数（正文在有序消息里）
partitions.runtime       作用域、回执、作业、证据、进度与变化
memoryStatus             分区占用、材料进出、配额和整理建议
```

请求按变化频率排列：系统提示（运行说明与宿主指令，会话内不变）→ 段底座（卷目录、最近一卷、段起点的驻留笔记快照）→ 段内历史（有序 user/assistant 消息，只往后加）→ 最后一条消息（本帧五分区、本帧协议与随机标记、阶段说明、完成反馈、ContextStatus）。内部 JSON 用于审计和投递确认；ContextMemory 的唯一文本渲染器将笔记、观察代码和输出排成可读正文。结果正文在段内历史与当前文本之间只发送一份；模型看不到产生它的源码时（延续结果、edits 或 sourceRef 产生的程序、失败编辑的草稿），结果条目附上当次源码。图片沿用原生图像块、存储引用与最终附件容量校验。

每轮都重新组装最后一条消息；段底座与段内历史第一次送达后冻结，同段后续帧逐字复用。驻留的模型笔记在底座快照里，段内的新 revision 出现在最后一条消息里并注明取代的旧版本；observe 每个正常业务轮刷新。历史脚本的出现和引用读取均不触发重跑。

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

搜索的来源/权限变化触发历史重置时，旧笔记、旧卷与段和旧自由历史一起退出活动投影；旧笔记引用不能通过 memory.read 绕回。重新获取授权证据后可以建立新笔记。持久对象保留和当前读取权限分别管理。

## 用户输入与文件

`session.submit({text,files,images})` 继续接受用户输入。原文先持久化；单对象超过 8000000 UTF-16 字符时分块保存，readInput 按逻辑位置跨块读取。文件以当前会话引用、名称、媒体类型和大小进入请求；图片独立归档和编码。

超大文本首次以有界摘录、遗漏范围和原文引用展示。主模型声明下一阶段工作意图，整理支线读取原文后提出版本绑定的输入摘要；Runtime 复用 summarizeInput 校验并发布意图投影。它带有 model-interpretation 来源，原始 user 记录不可变，新用户输入独立追加。摘要及引用不能证明全文已读或理解无误。

## 观察与近期材料

ProgramContext 继续负责不可变源码版本、观察指针和结果租约。observe 每个正常业务轮只读执行；execute 显式执行一次。源码变化与实际输出变化由 diff 报告提供，逐块另外记录内容和展示变化，diff 用于说明变化，当前正文独立发送。命名输出通过 output(value, options) 声明用途、类型和 view；整理工具只修改源码中的展示规则，并用本轮已归档数据重新组装。详细契约见 [声明式观察输出](script-output-observation.md)。

`execute({retain:2})` 为有限业务曝光次数；retain:'task' 到逻辑任务结束或显式释放。主任务默认 2，搜索默认 task。memory.retain 重设期限，memory.release 移出自动投影，memory.read 只读归档。只有成功业务响应所对应帧中实际包含正文的相同租约才消费一次；引用帧、失败、修复和维护轮不消费。后台晚到结果和新续租不能被旧帧消费。

RecentContext 是同一组装器的段内历史组件。它按 sequence 选择段起点之后的响应和结果（排除 observe 结果），加上从上一段延续、租约仍有效的结果；已冻结的条目逐字复用，新条目按单条上限渲染一次，结果租约到期或释放后那一条换成确定的引用卡。memory.list/read 可以发现和召回原文。

封段把段起点到切点之间的记录封成一卷（`context:volume`，写入后不再修改）：逐轮一行的规则骨架，不调用模型；最近 `recentRecords` 条记录（至少最近两个响应及其结果）和切点之前仍有租约的结果留给新段重新交付。整理支线可以给最新一卷写叙事（摘要、证据、未解项、否定尝试）；自动封成的一卷做了很多事、那一段又没改笔记和计划时，下一个请求边界由整理支线补写。底座列出全部卷和三张长期单（各卷叙事累积的否定尝试、最新叙事里的未解问题、输入摘要里的用户约束），段起点之前提出的任务目标只在底座列第一行，本帧尾只留最新的目标和段内新提的目标。卷目录同级超过上限时把最老的一批合并成上一级卷，目录条数有界。改造前的历史检查点在旧会话第一次投影时转成第 1 卷。卷、叙事与段状态都遵守当前授权代次，原文仍按引用召回。`recentRecords` 为 0 时不发送有序历史，有效租约结果直接进入 recent 分区，底座仍照常发送。

## 容量、变化与冻结

宿主可配置：

```js
context: {
  sources: [],
  memory: {recentRecords: 8, workspaceShare: 0.2, recentShare: 0.2}
}
```

搜索在 search.memory 配置，缺省 recentRecords:64、recentShare:0.4；业务子任务在 profile.memory 配置。workspaceShare 是底座笔记快照与本段改动笔记的预算份额（0.05–0.5）；recentShare 决定一条新历史第一次交付的上限（整帧剩余预算的 recentShare 的一半，最多 24000 字符，范围 0–0.5）；两者之和最多 0.8。recentRecords 是封段时留给新段重新交付的最近记录数（0–64）。宿主给的 workspaceShare 是起点：模型读回上一帧因容量不够只给了引用的笔记或没排进本帧的租约结果时记一次缺页，封段时笔记缺页多就把下一段的份额提高 0.05，执行结果缺页多而笔记没有就降低 0.05，一段里都没有缺页就向宿主配置回落一步，始终在上面的范围内。

份额约束可裁剪正文，放不下的笔记给引用卡，超出卡片数的给省略计数；卡片数量也随恢复窗口缩小。必要回执、用户目标和运行状态仍保留，最终消息及全部图片由 ProviderRequestCompiler 做总预算检查，分区字符计量不能代替最终 token 计量。

memoryStatus 报告各区 UTF-16 序列化占用，以及材料新增、版本更新、退出、仅引用；本段有缺页时列出次数和最近几次。源码和观察正文的实质差异仍在 runtime.progress 中。变化基线只在本轮响应完整成功后推进，容量重编译不会消费租约。已发出的帧不因之后的笔记更新被改写。

programFrame.resultsRevision 固定组帧时的新结果代次。完成检查用它识别请求发出后新进入租约集合的结果并补投递；同一帧中因预算省略的旧结果不会触发无限刷新。已有结果续租仍由 leaseId 保护曝光次数，不额外触发一轮消费。

ContextStatus 每轮报告 mode:partitioned、阶段、总输入估计与依据、窗口、输出/安全预留、剩余额度，以及剩余轮数与每轮增长、段号与卷数、上一请求的缓存读写；工作集本身快装不下时给出 overload 说明。估计按供应商实测用量校准。不设固定比例：剩余不足 2 轮或放不下时封段，剩余不足 8 轮且处在章节边界时封段；封不了段又不足 2 轮、封段后仍不足 4 轮或放不下，算结构性超载，主线每段最多运行一次整理支线。Provider 容量修复最多 2 次。

主线与业务子任务在安全轮边界调用独立 ContextMaintenance 模型工具。它持有固定父快照和分页材料读取能力，通过同一个 ScriptAct/RuntimeSession 提交 ContextPatch。Runtime 校验版本、保护引用和输入基线，复用既有机制，最后一次 CAS 发布全部元数据。笔记展示使用 ref/summary/resident，绑定不可变主笔记版本；整理不会改写主笔记正文或计划。补丁还支持用户意图、最新一卷的叙事（volume）、结果展示租约和观察输出呈现量。observe 源码由业务模型维护，下一业务轮照常运行新观察。

整理期间新输入或业务结果改变快照时，旧补丁不能发布；预算记账和租约心跳不会制造材料冲突。整理产生的派生展示保留到下一份策略或任务切换，策略变化时下一帧重建段底座。每次整理预留最后交付轮，收尾要求输出已有信息及未查明事项。搜索与整理本身是叶子工具：放不下时引用降级并进入最后交付阶段。

`memory.organize({focus?,preserve?})` 返回 scheduled 和持久 requestId，下一请求边界由 Runtime 先封段、再运行整理支线。实际结果在下一帧 memoryStatus.maintenance.lastAttempt 自动反馈，包括变更、保留引用、未解项和错误。总预算由 Runtime 决定。该操作只进入具备整理能力的主线和业务子任务合同。`velaros:context-materials.list/read` 只注入活动整理会话。

整理结束后重新执行 ProviderRequestCompiler，主线以 work 请求继续。此过程不运行业务脚本、不额外运行 observe、不消费父业务租约。失败时报告整理结果并确定性退为引用；基础目标、当前用户图片及必要运行状态仍必须通过最终窗口校验，否则 context_blocked。观察或执行图片若因展示预算退出，其原文引用、是否发送及召回方法随帧报告。

宿主通过 context.maintenance.model 选择独立驱动，省略时同一模型在独立会话工作；context.maintenance.profile 配置完整资源档位。默认 24 次模型调用、100 万 token、20 分钟，其中预留最后交付请求 65536 token/90 秒，资料读取最多 256 次/200 万字符。任务总预算仍从全部祖先总账支付。

## 实现与验证

- ContextMemory：工作笔记、版本 CAS、分区组装、投递变化基线。
- ProgramContext：源码与结果租约、实际观察内容和 diff。
- RecentContext：段内历史（只追加、冻结渲染）、封卷、卷目录与合并、权限代次和历史目录。
- RuntimeSession：同一组装入口、观察准备、执行和投递确认。
- ContextMaintenance / ContextMaintenanceState：独立整理活动、固定快照、原子补丁与结果回执。
- Context / Kernel / ProviderRequestCompiler：可靠存储、用户原文、事实与权限、预算和最终消息。
- SystemModules：modules/memory 两个系统成员；同一实现按主线与叶子作用域投影真实合同。

验收入口包含 context-memory.test.mjs、context-management.test.mjs、advanced-search.test.mjs 和原有执行/多模态回归。受控驱动验证机制和持久性；模型整理笔记、摘要与检索的实际质量仍需真实 Provider 评估。

## 宿主长期记忆

`velaros:system.memory` 将任务工作记忆与宿主长期记忆统一为一个模型入口。工作笔记仍由 update/list/read 管理，长期库通过 recall/save/remove 访问既有 MemoryScopePort。主线按需 output 召回内容，沿用已有结果归档、租约和分区预算；observe 中的 recall 每轮重新读取。长期 Markdown 文件独立于任务租约，整理和 release 只改变任务展示。宿主决定共享范围，搜索、整理和业务子任务的合同不继承长期记忆操作。
