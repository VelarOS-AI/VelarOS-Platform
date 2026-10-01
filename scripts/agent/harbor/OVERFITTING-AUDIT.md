# ScriptAct 过拟合排查（第 50 轮）

当前处理状态：四项发现已在第 51 轮完成对应修复与本地验证，见 [修复结果](OVERFITTING-FIXES.md)。以下保留第 50 轮诊断与复现证据。

本轮发现一处已复现的补读规则错误、一处编码指引的能力范围问题，以及两项泛化风险。这里的“过拟合”指把少数任务中有效的工程策略推广过度；这些证据不能证明模型权重发生统计意义上的过拟合。本轮以当前工作树、历史冻结清单和本地可控探针为依据。

## 已确认的问题

### F1 · P2：把条目索引当成字符偏移

位置：[model-instructions.ts](../../../packages/velaros/act/runtime/utils/model-instructions.ts)，`runtimeInstructions` 的分页说明，当前第 137 行。

第 49 轮增加了“selection.chars 或 selection 的 from/shown 为原字段的 UTF-16 范围”。这对所有 `selection` 并不成立：`output-render.ts` 的数组分支与 `materials.ts` 的数组节选都用条目数；只有明确标为 `unit: 'utf16'` 的范围才是字符坐标。`readMaterialField` 则把数组序列化成 JSON 后按字符分页。因此，遵循当前指引会读回错误的位置，造成重复内容、遗漏或额外往返。

已复现：100 个对象只展示前 3 个，得到 `selection={from:0,shown:3,total:100}`。按指引从字符 3 补读，返回内容仍在第一个对象；真正第四项的序列化起点为 190。数组字段路径和读取实现本身有效，错误位于给模型的解释。

同一探针还验证了尾段边界：2489 字符的字符串展示 `[1390,2489)`，`from + shown` 等于 2489，继续向后读返回空串，缺失前缀仍未补齐。“补读尾部”的公式本身适用于后方缺口，但不能作为所有截断的恢复办法；这项边界复现不代表真实模型一定会选错方向。

修复要求：区分条目、行号与 UTF-16 坐标；数组用对应条目的 JSON Pointer 或有明确定义的序列化分页。字符串根据缺失的前缀、后缀或区间决定读取位置。回归应覆盖“展示元数据 → 按指引构造读取 → 实际取得缺失内容”的完整链路。

### F2 · P2：通用运行时无条件注入编码策略

位置：[model-instructions.ts](../../../packages/velaros/act/runtime/utils/model-instructions.ts)，当前第 101、137 行；调用方为 [RuntimeSession.ts](../../../packages/velaros/act/runtime/impl/RuntimeSession.ts) 第 334 行。

文件定位、`oldText` 编辑锚点、改后验证、工具链/PATH 和代码命令回执拆分建议被放入公共说明，没有按实际 Project/Shell 能力或编码任务配置选择。相比之下，同文件的专门 Shell 说明已按模块授权启用。

已通过正式 `createRuntime` 复现：关闭 project、agents、search、长期 memory，不授予 Shell，提交普通翻译请求。到达可控模型桩的 `request.instructions` 仍包含 `oldText`、PATH 和 `stdout` 代码拆分示例。会话正常完成，证明范围问题真实存在，而非只由人工构造的空模块参数造成。

这会增加与当前任务无关的指令和上下文；是否已造成真实非编码任务质量、延迟或费用下降，本轮没有模型实测证据。修复要求：核心保留任务推进、回执核对和完整性原则，编辑策略按相关能力或明确任务配置注入，Shell 策略按 Shell 能力注入，避免单凭任务文字猜测能力。

## 泛化风险

### R1：重复观察的题目属于调优证据，自动隔离尚不充分

第 38、39、40、41、42、43、45、46、47 轮清单合计九轮，只包含四道独立题：Flipt 两轮、Vuls 两轮、OpenLibrary 一轮、Navidrome 四轮。重复实验对诊断有效，但修复后再做同题比较，不能证明新题上的泛化收益。

已有保护：`campaign.json` 区分开发与验证任务，要求用来指导修复的任务转为开发证据；同题清单明确写出独立题数不增加，冻结参考尝试；`metrics.py` 返回 `supports_general_superiority: false`，保留完成尝试总费用，条件成功效率的口径也有说明。本次没有发现现有报告把这些重复题声称为新增独立验证。

剩余风险：`task_role` 是自然语言字段；`repository_report.py` 的参考清单验证检查协议、身份、哈希和重复来源，却没有根据历史暴露记录强制检验开发/留出归属。后续宜维护结构化任务暴露记录，以首次观察、用于修复的候选和冻结时间校验统计归属。当前已冻结的新题组应继续保留其独立性。

### R2：工具预探测的覆盖范围有限

位置：[run.mjs](run.mjs)，当前第 24–40 行。Harbor 宿主按根目录的 `go.mod`、`package.json`、`pyproject.toml`、`Cargo.toml` 探测一组命令。只使用 requirements/setup、Maven/Gradle 或嵌套模块布局的项目，以及 pnpm/yarn 工具链，无法得到相同程度的预探测。

这是有界环境适配，不是题目答案硬编码；未探测的工具也没有被直接判为不存在。风险在于把已覆盖几类工程的收益推广到全部工程。修复时应保留“未知”的含义，按实际项目配置和必要检查补充发现，避免无条件扩大启动扫描。

## 本次没有发现的题目特例及合理边界

审查范围包括 agent、context、ScriptAct、script、model、kernel、project、shell 的产品实现，以及 Harbor 运行与报告链路。对历史仓库/题目名称、`getYear`、基准名称及特定工具路径的产品源码扫描没有命中；测试、生成物和基线目录单独排除。本次范围内未发现按这些题名分支、注入标准答案或替换任务补丁的产品逻辑。这是有界审查结论，不能排除所有间接依赖。

以下修复有可辨认的通用语义依据：glibc/musl 和进程组兼容、精确编辑失败候选原文、保留完整来源的展示截断、增量轨迹导出、失败/未知费用保留。成功回执分组还要求摘要实际更短，并保留失败与未知结果。回归测试引用历史错误样本本身合理，关键是继续覆盖不同形状和边界；F1 说明此前测试没有覆盖模型指引与数组分页单位之间的一致性。

## 本地证据与交付范围

- [边界探针](../../../.velaros-workspace/bench/overfit-audit-50/probe.mjs)：从仓库根运行 `node .velaros-workspace/bench/overfit-audit-50/probe.mjs`，本轮通过。
- [探针结果与源码/构建文件哈希](../../../.velaros-workspace/bench/overfit-audit-50/edge-cases.json)：数组、尾段与正式非编码 Runtime 三类边界；模型响应由本地桩提供，provider 请求为 0。
- [历史任务暴露摘要](../../../.velaros-workspace/bench/overfit-audit-50/task-exposure.json)：保留九轮清单的原始任务角色说明。
- 首次正式 Runtime 探针误把帧正文 `compiledPrompt` 当作系统说明，断言失败；改为检查正式字段 `request.instructions` 后通过。未为此改变产品实现。

本轮新增审计文档与本地证据，没有修改产品行为或历史测评数据，新增 API 费用为 0。修复优先级为 F1、F2，再补 R1 的自动归属校验；R2 按实际工程覆盖需要扩展。原有本地回归通过不能替代这些跨场景检查，也不能据此认定整题请求、时间或费用已有改善。
