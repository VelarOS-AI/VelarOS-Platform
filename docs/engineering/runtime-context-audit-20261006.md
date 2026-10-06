# Runtime 静态与动态联合审查差量报告

本轮修复了三处可复现的通用运行时缺陷，并补齐评测启动预检。365 项相关回归通过，两项真实模型配对任务的请求数和耗时下降；独立产物复核同时发现 Commander 候选代码破坏了一个已有 API 行为。因此，本轮支持交付这三处基础修复，尚不支持“整体任务质量提高”的结论。

分支：`feat/runtime-context-audit`。基线提交：`589ceae6598a51dd1bdf30d18be469282da86b5f`。候选为同一提交上的本轮差量，冻结时间为 2026-10-06 14:35:52 UTC。两份快照及当前产品源码已逐文件核对，真实模型执行使用冻结候选。

## 1. 问题、改动与直接证据

| 问题 | 根因及改动 | 验证 |
| --- | --- | --- |
| 按需查询的包版本与实际导入不一致 | 目录原先固定指向运行时后备安装，Node 正常解析却优先使用工作区依赖。程序启动时，由实际 Node 子进程依据入口用 `findPackageJSON` 发现清单，再由宿主发布目录。每项独立记录版本、路径、来源或错误。 | 同一工作区实际导入 Execa 5.1.1，基线目录错误显示 9.6.1；候选正确显示 5.1.1 及相应 README。只读执行成功，允许写入目录仍为空。 |
| 精简上下文可能遗漏本次失败反馈 | `nodeFrameState` 原先只根据停滞、证据或脚本变化等条件保留 progress。现将独立的 `feedback` 也保留，使当前失败与恢复入口能够进入精简帧。 | 使用没有 stalled/changed 标记的反馈回归；基线失败，候选通过。此处修复的是精简当前帧，历史记录本来仍可能包含错误。 |
| 上下文整理的边界与要求不一致 | 交互整理只在易被裁剪的初始任务里携带卷边界；目录可能列到父快照末尾，指令又要求重复携带旧事项。现把 `volume: {ref, from, through}` 放入稳定控制材料，卷目录按自身上界筛选，提示词和合同统一为只提交本卷新增 unresolved，已有事项由宿主持久保留。 | 覆盖卷边界、分页、原始输入交付、已有事项保留、叙事引用核对和并发父输入变化。 |
| 冻结评测控制器启动失败 | 预备脚本只复制打包帮助文件，遗漏其本地依赖。现一起冻结所属 release 脚本，并从冻结副本执行真实命令帮助器预检。 | 保留两次零模型调用的启动失败；成功预检后才开始模型请求。命令执行与任务环境相关的 19 项测试通过。 |

主要实现位置：

- [NodeRuntimePackages](../../packages/script/src/impl/NodeRuntimePackages.ts)、[Node 启动源码](../../packages/script/src/utils/node-program.ts)、[NodeCodeRunner](../../packages/script/src/impl/NodeCodeRunner.ts)。
- [精简帧](../../packages/velaros/act/runtime/utils/node-context.ts)、[整理状态](../../packages/velaros/act/system/impl/ContextMaintenanceState.ts)、[整理指令](../../packages/velaros/act/runtime/impl/ContextMaintenance.ts)。
- [冻结预检](../../scripts/agent/long-tasks/prepare.mjs)。

依赖发现放在执行子进程，是因为宿主的 Node 包清单缓存可能跨次执行保留旧的包自引用信息。宿主通过已有鉴权桥接接收一次 `/packages` 发布，核对条目数量与名称后写入本次内部目录；程序模块在发布成功后才导入。只读程序继续使用原有文件权限。标准 npm 的说明保留在原包中，模型按需读取。

### 公开合同与提示词影响

- `NodeRuntimePackageReference` 现在表达“当前入口可发现的包”，与后备安装配置 `NodeRuntimePackage` 分离。新增 `source` 和逐条 `error`；`version`、`root`、`packageJson` 允许缺省，查询结果不再带安装配置的 `directory`。消费方应检查可选字段，并用 `root`/`packageJson` 定位实际依赖。当前仓库与 Desktop 源码搜索未发现依赖旧字段的外部消费点；对公开类型的消费者仍是需要适配的合同变化。
- 目录以当前执行入口为准；从其他位置运行的独立脚本继续按其自身位置进行标准 Node 解析。
- `runtime.modelTool.volume` 是新增控制材料。`context-materials.list` 的卷模式限定为该卷上界；用户原文仍按原有机制送达。叙事提交的来源校验继续生效。
- `VolumeNarrative.unresolved` 的说明与已有持久化行为对齐。声明和模型合同从 TS 重新生成，README、不变量一并更新。

## 2. 静态门禁与确定性回归

| 检查 | 最终结果 |
| --- | --- |
| Node runtime、context maintenance、volume narration | 165/165 |
| Script 执行、输出、子进程、模块语义与诊断 | 165/165 |
| Skill 验收 | 16/16 |
| 冻结命令与任务环境 | 19/19 |
| 增量构建；Script、Velaros 类型检查 | 通过 |
| 全仓 lint、format、差异空白检查 | 通过 |
| 模块所有权、代码风格、错误构造、生成模型合同 | 通过 |

上述测试合计 365 项，不包含模型任务自己的验收与项目测试。完整仓库总入口 `bun run check` 本轮未执行。

六项针对修复点的回归在冻结基线上均产生断言失败；候选通过。包查询覆盖别名、作用域包、隐藏清单的 exports、嵌套入口、符号链接、自引用、损坏或无版本清单、两次执行之间更新清单。另用真实 Execa 安装进行版本与只读权限对照。

过程中曾发现“让子进程直接写内部目录”破坏只读整理执行；这次中间回归及中断日志保留。当前实现改由宿主发布，最终 165 项运行时回归是在最终源码上通过的。

## 3. 真实模型配对结果

统一条件：`gpt-5.6-sol`、high、正式 Model provider 链路、普通 request 模式、标准 Node 环境；上下文 65,536、输入窗口 32,768、最大输出 12,000。每项任务每个版本各执行一次。提示词在基线运行前固定，评分器对模型隐藏；生产修复不包含题目或仓库特例。

| 指标 | ShellJS 基线 → 候选 | Commander 基线 → 候选 |
| --- | --- | --- |
| 冻结功能验收 | 6/6 → 6/6 | 6/6 → 6/6，使用修正后的同一 v2 评分器 |
| 原有项目回归 | 614 通过、7 跳过 → 相同 | 1365/1365 → 相同 |
| 请求数，包含整理支线 | 12 → 9，下降 25.0% | 18 → 16，下降 11.1% |
| 主任务 / 整理请求 | 12/0 → 9/0 | 15/3 → 16/0 |
| 解题耗时 | 194.713 → 150.498 秒，下降 22.7% | 271.908 → 210.666 秒，下降 22.5% |
| 参考费用 | $0.430028 → $0.353181，下降 17.9% | 基线已知 $0.950749、总额未知；候选 $0.675616 |
| 用量完整性 | 两次完整 | 基线缺 1 次；候选完整 |
| 完成后的兼容性补验 | 通过本轮复核 | 基线通过；候选失败，见下文 |

费用来自冻结参考价，并非供应商账单。Commander 基线缺少一次 usage，因此不计算完整费用降幅。候选两项任务都没有触发交互整理调用，不能把这两项的耗时变化单独归因于整理修复。单次采样还包含模型随机性、服务时延与缓存差异。

### 静态复核发现冻结测试漏项

Commander 候选在添加查询方法时，同时将已有 setter 的普通赋值替换成 `Object.defineProperty(..., {configurable: true})`。因此，`storeOptionsAsProperties()` 下原本可更新的可写、不可重新定义属性会抛错：

```js
const cmd = new Command().storeOptionsAsProperties().option('--port <number>');
Object.defineProperty(cmd, 'port', {
  value: 80, writable: true, enumerable: true, configurable: false,
});
cmd.setOptionValueWithSource('port', 81, 'config');
```

同一补充探针在原始项目和基线产物上成功，候选抛出 `Cannot redefine property: port`。这是模型生成的评测项目代码中的回归，不是本轮 Platform 源码中的 setter。原始评分和候选产物完整保留；冻结测试 6/6 只说明其覆盖范围内通过。该任务要求保留已有 API，因此候选不能认定为完整交付成功。

ShellJS 候选自行直调测试时，因命令环境缺少 `shx` 报过一次失败，并在最终答复中披露。独立使用项目测试脚本补验，同一产物为 619 通过、7 跳过，lint 通过；原始失败记录继续保留。

Commander 独立补验按冻结环境约定清除 `NO_COLOR` 后，1371 项 Jest、ESM、JS/TS 类型、tsd、lint 和格式检查全部通过。首次补验继承了宿主的 `NO_COLOR`，产生 4 项颜色判断失败，其日志也保留。这组项目检查仍未覆盖上面的属性兼容性回归。

Commander 初始 v1 评分器有两处错误：误判已有 `getOptionValueSource('__proto__')` 行为，以及 TS 用绝对 `index.js` 入口绕过声明映射。在候选模型调用前，按冻结任务约定修正为调用原 getter 比较来源、通过包入口读取声明。基线初评 4/6 原样保留；同一基线产物 v2 补评 6/6，没有重新运行模型。

### 开发样本与剩余问题

Chai 开发运行花费 71 次请求、1193.565 秒，原有 507 项回归通过，新增功能验收仅 2/77。最终答复明确承认未完成，并将自身保留的编辑误认为原有改动。14 次请求用于整理，4 次缺少 usage，已知参考费用为 $3.355694。该样本用于定位根因，本轮没有候选重跑，不能声称已经改善其长任务完成率。

最终请求中仍存在原始用户输入，因此不能把失败简单归因于“用户要求丢失”。协议结束状态 `completed` 也不能替代任务验收。下一轮的通用研究重点是交付复核：将最终差异、实际检查结果、兼容性行为和完成声明一起核对，并用新的冻结任务验证质量与额外成本。

## 4. 证据与交付边界

本轮共 126 次真实模型请求，5 次缺失用量，已知参考费用合计 $5.765267，完整总额未知。

本地完整证据位于 `.velaros-workspace/bench/runtime-context-20261006/`：

- `comparison.json`：配对指标、v1/v2 评分差异、补充复核和费用覆盖率。
- `baseline/manifest.json`、`candidate-v1/manifest.json`、`final-integrity.json`：冻结源码与完整性核对。
- `validation-freeze.json`：题目、评分器哈希和冻结约束。
- `package-resolution-comparison.json`：真实 Execa 版本与只读执行对照。
- `commander-preserved-api-probe.json`：兼容性补充探针及三个版本的结果。
- 各 attempt 的 `metrics.json`、`scriptact/requests/`、原始 wire、轨迹、执行记录、验收和回归结果；完成工作区归档于 `workspace.tar.gz`。
- `regression-*.log`、`*-final.log`、`typecheck-*.log`、`script-contracts.log`：本轮代码验证结果。

修复收益已经落实到依赖事实、失败可见性和整理边界。真实任务的速度观察保留为初步数据；交付质量继续按静态复核和动态验收共同判定。
