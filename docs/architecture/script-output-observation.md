# ScriptAct 声明式观察输出

状态：正式接入 `@velaros-ai/script` 和 `velaros/act`。源码、结果、摘要和补丁发布都沿用 ContextStorage；能力调用沿用 Kernel；模型请求仍由 ProviderRequestCompiler 校验。

## 模型接口

```js
import {output} from 'velaros';
output.configure({maxChars:16000});
// 业务数据读取放在这里，权限和观察模式由原能力链路执行。
const state = {status:'ready', count:3};
output(state, {
  key:'state', purpose:'持续确认本次任务的当前状态', type:'json', priority:'high',
  view:{paths:['/status','/count'], maxChars:2000}
});
```

`output(value)` 保持可用；第二参数提供稳定 key、用途、内容类型、语言、重要程度和展示规则。一次执行中 key 唯一，省略 key 时系统生成当次序号，不把它当作跨源码版本的稳定语义身份。重复 key 是明确错误，即使脚本 catch，采集问题仍进入回执。

`required:true` 需要显式稳定 key，声明本轮决策必须完整可见的原值。Runtime 优先分配这些块；原文、完整原生图片满足要求，摘要、切片、引用或未产出不满足。observe 与尚有租约的 execute 结果都遵守此规则。缺口进入 `runtime.decision.missing`，外部写入及完成被阻止；模型仍能通过系统能力释放不再需要的租约，或修改观察源码。整理工具不能改变 required 声明。

`output.configure` 在第一次输出前调用一次。`maxChars` 是 UTF-16 字符数，整体输出文字目录与正文受其约束，观察源码、其他分区和原生图片由各自预算及最终请求编译器处理。每块 view.maxChars 约束该块正文。源码默认申请 16000，最多申请 200000，实际可用容量取宿主分配与源码申请的较小值。

原始输出最多 64 块、合计 1000000 个 JSON 字符；这是采集安全边界，和展示预算分开。单份声明最多 4000 字符，嵌套深度最多 64。采集在 output 调用时复制 JSON 值，不运行 getter/toJSON，不接受循环引用、非有限数字或函数。原始值在隔离堆中编码，经受限 IPC 立即交给宿主；后续抛错、计算超时及取消仍保留宿主已收到的块。值本身尚未产生之前的读取和计算仍由原运行预算管理。

## 类型与展示

| type | value | view 行为 |
| --- | --- | --- |
| text | 字符串 | 选择行段或完整首尾行；单行放不下时使用引用 |
| code | 代码字符串 | lines 为一基闭区间；保留范围说明，不把半截代码当完整源码 |
| json | JSON 值 | paths 为 JSON Pointer；缺失路径显式列出；超大字段可以引用化 |
| list | 数组 | maxItems 和 edge 选择头部/尾部完整条目，记录总数与范围 |
| image | Kernel image-data 或带 ref 的对象 | 原生附件与文字引用分开；引用模式可卸载原生图片 |
| file | 带 ref 的元信息对象 | 展示 name/mediaType/bytes/ref；正文通过已有授权读取入口召回 |

省略 type 时：字符串为 text，数组为 list，其余为 json。类型是模型声明的内容格式，不提升事实可信度。language 是代码语言说明。

view.mode 有 auto/full/reference/summary。auto 做确定性选取；full 无法完整满足时报告 full-unavailable；reference 明确不带正文；summary 只消费外部整理模型已经提供且验证指纹的摘要。output 本身不调用模型。high/normal/low 是预算排序，和异步输出到达顺序无关，也不突破最终窗口。

JSON 字段指针、原始结果 ref 和 `/output/blocks/<index>/value` 定位到归档。results.read 仍按原始结果 ref 和 offset/limit 分页；pointer 是归档内位置提示，不是独立的权限或自动读取承诺。文件引用的权限由已有文件/输入读取入口判断。

## 原值、预览和归档

CodeSurfaceOutcome.output 保存完整捕获块；result 保持既有的有界执行预览。没有显式 output 的正常导出，完整值另外放在 rawValue。模型工具的结构化交付从原值解析，不能把预览截断后的字符串当补丁或搜索答案。

超过归档上限的块明确失败，不能承诺引用后面藏着完整原文。已捕获块和采集问题保留。原生图像不会作为输出展示正文的 base64 文本传回；脚本自己把数据字面量写进源码时，源码本身仍是模型材料。

## 源码是持久展示规则的唯一来源

ScriptOutputs.describe 提取主源码顶层、直接从 velaros 导入的 output 调用。支持导入别名，按 TypeScript 符号身份判断；同名局部函数、函数体内部输出、动态 options 或 getter 不能被自动改写。它们仍可通过正常 ScriptAct 执行，但不能让整理工具猜测声明位置。

展示补丁只接受：

```json
{
  "sourceRef": "当前观察源码引用",
  "config": {"maxChars":9000},
  "outputs": [
    {"key":"state","view":{"paths":["/status"],"maxChars":1000}}
  ]
}
```

config 和每个 view 是完整替换；未列出的块保持原声明。补丁不能改变 value 计算、key、purpose、priority、导入、权限和执行顺序。编译器修改字面量 AST 对应范围，保持采集代码逐字不变。配置缺失时可以在导入后添加 configure；动态配置不能自动改写。

ContextMaintenanceState 在既有 ContextPatchStore 中调用 ProgramContext.editObservation，连同笔记、输入摘要、卷叙事和结果释放在一次 CAS 发布。任何部分失败，源码与其余元数据都不发布。新输入、源码更新或结果变化会使快照版本失效。

发布前实际组装候选五分区，校验必需正文和已确认输入约束，并调用父模型的 ProviderRequestCompiler 做预算预检；预检取消不等待迟到计量。最终请求在加入本轮状态、阶段及恢复说明后再次计量。整理产生的摘要和笔记呈现保留到同任务下一份策略或任务切换，策略变化时下一帧重建段底座；每轮继续采集真实观察。源码内的展示修改保持为可见版本。

补丁只发布新源码及元数据，不执行观察程序。当前帧从已归档结果重新展示：collectedSourceRef 指向原采集版本，presentationSourceRef 指向当前源码版本，adjustment 说明整理原因和 executed:false。下一正常业务轮才使用新源码刷新采集。

## 摘要和变化基线

整理补丁可同时提供 summaries：key、resultRef、contentHash、text。Runtime 验证它属于当前观察结果，将摘要绑定原值 SHA-256、用户目标代次和授权历史重置代次。原文变化或目标代次变化后摘要不可复用，显示 summary-unavailable。摘要始终标为 model-interpretation；版本验证不能证明其语义没有遗漏。

主线可以请求一次上下文整理；容量压力也可以触发既有有界整理服务。summary 模式本身不隐式启动另一模型。

观察健康状态按源码版本保存：普通失败进入 degraded，连续三次失败暂停，已派发但效果不明的操作立即暂停并等待核对。模型看到最后结果、最后成功结果的引用与采集时间；展示修改不会清除暂停，实质源码更新可恢复采集。shell 的防护范围和操作是否已收束分别记录，部分防护不等于没有副作用。

宿主另外报告 durationMs、capabilityCalls 和 rawOutputChars；它们分别是执行耗时、能力调用数和输出归档量，不能代替外部资源实际读取字节数。

源码 diff、原始结果 diff 沿用已有进度报告。逐块 outputChanges 额外区分 added/updated/unchanged；presentationChanges 报告表示或源码展示规则的变化。基线只在业务响应完整接受后推进，重编译与维护调用不推进。missingOutputs 表示声明存在但本次没有产生；exitedOutputs 表示相对前帧未出现，不能据此断言外界内容被删除。

## 图片、失败与租约

显式 image 输出映射到现有附件引用，nativeImages 说明是否实际附带。reference 模式或容量恢复可以卸载图片，原始记录继续可读。用户上传图片保持既有独立附件路径。

原始结果失败、捕获问题、未知操作效果不因 view 缩减而消失。collection、failure、collectionIssues 与块正文分别提供，空数组和失败不混为一谈。

execute 也使用同一 output，持续可见性仍由结果租约控制。正文已经在近期有序历史中发送时不会再发第二份；结构化块不能在历史层被裁成残缺 JSON。纯引用不消费展示租约，原生图像实际显示时计入曝光。

## 验证入口

- Script 引擎：`bun test packages/script/spec/acceptance.test.ts packages/script/test/script.test.ts packages/script/test/output.test.ts`。
- Act 集成：`node --test packages/velaros/act/runtime/test/output-context.test.mjs`。
- 回归：runtime、system、search、agents 原测试入口。
- 结构门禁：`bun run check:module-ownership`、`bun run check:script`、`bun run check:act-catalog`。

自动化使用真实隔离执行器、ContextStorage、Kernel 和独立模型工具调度，模型响应由确定性测试驱动产生。真实在线模型选择观察范围、编写摘要的质量需要另外评测。
