# 高级搜索：正式运行链路

搜索是普通脚本能力。主模型在 execute 中调用 `velaros:search.search`；搜索模型使用同一个 ScriptAct 文本协议、Agent Loop、脚本执行器与存储，使用统一五分区上下文，缺省配置较大的近期历史窗口。Runtime 校验真实来源、控制预算和发布报告。完整上下文设计见 [context-management.md](./context-management.md)。

## 调用和返回

```js
import {search, read} from 'velaros:search';
import {output} from 'velaros';
const report = await search({query:'寻找登录状态恢复路径', profile:'standard'});
output(report);
// 后续一次 execute 中可继续：
// const next = await search({resume: report.ref, query:'继续确认持久缓存路径'});
```

search 是 execute-only，由 Kernel 的 allowedModes 校验真实入口，别名和函数包装不能绕过。effects 保持 none，搜索成本由模型和来源预算单独计量。observe 可以调用 `read({ref, mode:'current'})` 持续读取已选目标；snapshot 为历史报告分页读取，传入 evidenceId 可召回该报告对应的原始证据分页。current 不调用模型、不扩展语义搜索范围；基线变化后无法可靠重定位的行号返回 STALE_SELECTOR。

返回 SearchResult：不可变报告 ref、searchId、profile、status、stopReason、continuation、findings、真实 evidence、gaps、nextSteps、coverage 和 usage。findings 是模型解释，evidence 由 Runtime 读取和登记，引用不存在的结论拒绝。completed 表示本次搜索报告通过交付规则；不能证明检索范围之外不存在其他信息。

`ref` 是报告引用；父 execute 的 `resultRef` 是脚本结果引用，后者由父作用域租约管理。JS 变量只有通过 output 才进入模型可见结果。同步调用等待返回；`execute({async:true})` 使用现有后台调度，仍受同一预算和父取消约束。

## 搜索内部

搜索只获得 evidence、modules、programs、results、artifacts、inputs、history、workspace、execution 的作用域能力。模块发现和真实派发按同一允许范围检查。它通过 `evidence.query({source,query,limit?})` 获取候选，通过 `evidence.read({target,maxBytes?})` 获得证据 ID、原文引用与版本。Sources 复用 ContextSourcePort，EvidenceAccess 统一 authorize/read/hash/version 规则。

搜索以 blobs/execute/done 维护和运行脚本，默认 retain:'task'。每次接受的响应和真实结果进入同一对象存储中的有序历史。交付使用：

```js
import {output} from 'velaros';
output({
  findings:[{text:'已定位登录恢复入口',evidenceIds:[evidenceId]}],
  gaps:[{code:'UNRESOLVED',detail:'尚未确认缓存写入顺序'}],
  nextSteps:['继续读取持久缓存实现']
});
```

随后输出本帧的 done 声明。done 只完成搜索激活，父任务由自己的主循环继续处理。

## 外部预算

宿主装配 `search:{model,defaultProfile,profiles,contextPolicy?}`。档位名称自由配置；每个 SearchProfile 明确 modelCalls、modelTokens、finalizationTokens、timeoutMs、callTimeoutMs、finalizationMs、outputTokens、projectionChars、sourceQueries、candidates、reads、readBytes，可配置 noProgressRounds 和 publicationMs；publicationMs 为最后来源核验与本地发布预留时间，缺省 1000ms。

至少预留最后一次调用和 finalizationTokens。预留先进入父任务共享账本，其他并发搜索不能占用；提前完成释放未使用的收尾预留。探索前检查调用、token、时间和来源额度，最后机会在请求中明确提示交付现有证据、未解点和后续建议，能力门关闭新增探索。每个 Provider 尝试、修复和维护均计费。

单次 Provider 调用有独立取消截止，忽略取消的驱动也不能让 Agent 无限等待。搜索绝对期限取自身档位与已知父期限的较小值；父取消随时生效。预算不足或模型异常时从已有状态形成 partial/failed，不用额外模型补写结论。缺失的 Provider 用量标为 null。

## 续查与权限

报告 ref 绑定原始 searchId 和恢复状态，续查重新获得当前授权与档位。最新报告以同一存储中的记录登记；陈旧报告续查返回 CHECKPOINT_STALE。跨实例 CAS 占位防止并行续查覆盖和重复执行。

报告发布后仍保留活动 claim，直到内部会话关闭流程完成。关闭前且持久租约有效时，跨实例续查返回 SEARCH_BUSY；当前实例仍有活动句柄时也拒绝重入。预算、会话和 claim 清理分别尝试，失败返回 SEARCH_CLEANUP；已保存报告保持可核查，存储故障导致的残留 claim 继续受原期限约束。搜索预算关闭幂等，确认预留但未派发的模型调用按取消归还预算，已经发出的调用不自动退款。父脚本按执行身份等待所属搜索清理及已开始的本地账务结算，再结束任务租约；普通子 Agent 的关闭也等待父预算结算。

每轮和发布前检查已有证据的权限和版本。范围收窄或证据变化时，相关旧自由历史退出活动投影；旧引用读取和源码复用也经过当前边界。当前请求保留原始目标、允许的证据和变化反馈。源正文始终保持真实版本与采集时间，历史脚本不会因恢复重新执行。

来源范围按身份比较；等量替换也会重置旧来源的候选和自由历史。只增加来源且原证据仍有效时保留既有历史。

`history.list({after,through,limit})` 在当前授权代次内分页返回响应与执行结果引用，包括检查点已经概括的记录。返回的 through 用作下一页的固定上界，nextAfter 为下一页下界。投影因 64 条容量上限省略历史时，附带可直接调用的目录范围；拿到 ref 后使用 history.read。历史重置后的首个 checkpoint 使用 baseThrough:0，不能引用重置前的自由材料。

## 接入文件与验收

ComposedRuntime 装配 AdvancedSearch；AdvancedSearch 建立共享 RuntimeSession；SearchActivation 管理档位、来源预算与报告；ContextMemory 组装五分区，RecentContext 管理近期历史，memory 维护 workspace 中的搜索笔记。所有模型调用仍通过 ActLoop 和 ProviderRequestCompiler。SearchModule/EvidenceModule 定义模型操作，StandardModules 汇总装配。

机制验收位于 `packages/velaros/act/runtime/test/advanced-search.test.mjs` 与 `context-management.test.mjs`，包含正式能力调用、存储、执行、续查、范围拒绝、最后一轮、并发预算、模型挂起、输入归档、材料引用、检查点和多模态编码。真实模型质量评估需要宿主提供模型配置。

异常收尾和预算派发边界见 [搜索续接加固](../engineering/act-search-lifecycle-delta.md)。


`profiles()` 返回 `{name, default, limits}`，档位预算由宿主决定。`read({ref,mode:"snapshot"})` 返回保存正文的 `text/offset/totalChars`；`mode:"current"` 返回 `items`，每项用 `ok` 区分真实正文与缺口，`complete` 说明选择范围是否完整。两种读取都不会发起模型调用。
