# Runtime 修复与三轮追加对照差量报告

本次延续 [静态与动态联合审查](runtime-context-audit-20261006.md)，补齐通用交付复核指令、兼容性验收和评测临时目录隔离，并追加三组、六次真实模型运行。两个冻结验证题通过功能与原项目回归；Commander 开发重放仍暴露特殊属性兼容性错误。三组请求总数相同，候选累计耗时更长，现有证据不支持整体效率或交付质量提高。

## 1. 本次交付差量

| 范围 | 改动与理由 | 验证及边界 |
| --- | --- | --- |
| Runtime 交付指令 | 将既有收尾句收敛为核对原始需求、最终差异、受影响调用方、兼容行为和实际检查结果。仍使用现有 Node 工具与标准包。 | 冻结 `candidate-v2` 参加全部三组对照；最终 5,386 个冻结文件与当前工作树哈希一致。该句是行为要求，不能替代产物验收。 |
| Commander 验收 | 增加已有 setter 的可写不可重新定义属性、访问器 setter、只读属性检查，覆盖两种存储模式。完成后静态复核又扩展到 `__proto__`、`constructor`、`toString`。 | 运行前冻结 v3；完成后追加 v4 补验。原始产物与所有版本评分分别保留。 |
| 评测环境 | 每个 attempt 将 `TMPDIR`、`TMP`、`TEMP` 固定到自身根目录的 `tmp`，准备、模型执行及派生测试进程共用该目录；冻结与运行时核对路径。 | 两个真实子进程同时使用同名临时文件仍相互独立；拒绝符号链接临时根。任务环境与命令执行 21/21。 |
| 独立验证题 | 增加 fs-extra 链接存在性和 ShellJS 相邻单例过滤题及其验收。 | 任务、评分器和候选在模型请求前冻结；评分器及人工正例不向被测模型提供。 |

相关位置：[交付指令](../../packages/velaros/act/runtime/utils/node-instructions.ts)、[运行时约定](../../packages/velaros/act/runtime/README.md)、[任务临时环境](../../scripts/agent/long-tasks/task-environment.mjs)、[准备](../../scripts/agent/long-tasks/prepare.mjs)、[执行](../../scripts/agent/long-tasks/run.mjs)、[兼容性评分](../../scripts/agent/long-tasks/test_commander_option_snapshot_acceptance.mjs)。

本次提示词差量是下面这一句，未增加工具调用协议：

> 持续完成用户请求的全部范围。结束前核对原始需求、最终产物与实际验证结果；有改动时审阅最终差异和受影响的调用方，检查既有行为与兼容约束，修复发现的问题再交付。只把验证覆盖到的结论报告为已验证，明确未完成事项和证据缺口。

本次与上一轮代码一并交付：包查询与实际 Node 解析一致、精简帧保留独立失败反馈、上下文整理卷边界与新增事项语义、冻结控制器依赖及启动预检。公开包查询类型和整理合同的变化及影响见上一份报告；本次没有进一步改变公开能力合同。

## 2. 三组真实模型结果

本轮基线是上一轮的 `candidate-v1`，已经包含三处基础运行时修复。新候选是在此基础上加入上述收尾指令的 `candidate-v2`。两份源码的基础提交都是 `589ceae6598a51dd1bdf30d18be469282da86b5f`，具体内容由各自快照清单哈希确定。该对照只观察新增指令的差异。

统一条件：`gpt-5.6-sol`、high、正式 Model provider 链路、普通 request 模式、标准 Node 环境；上下文 65,536、输入窗口 32,768、最大输出 12,000。每组两边各运行一次。耗时为解题墙钟时间，请求数包含整理支线；参考费用使用冻结单价，不是供应商账单。

| 任务 | 功能验收：基线 → 候选 | 原有项目回归，两边相同 | 请求数 | 耗时，秒 | 参考费用，美元 |
| --- | --- | --- | --- | --- | --- |
| Commander 查询快照，开发重放 | v3：7/9 → 9/9；v4 补验：7/9 → 7/9 | 1,365 通过 | 19 → 28 | 264.671 → 412.960 | 0.887891 → 已知 1.456484，缺 1 次用量 |
| fs-extra `followSymlinks`，冻结验证 | 7/7 → 7/7 | 745 通过，8 跳过 | 18 → 9 | 246.722 → 181.369 | 0.926282 → 0.505570 |
| ShellJS `uniq -u`，冻结验证 | 5/5 → 5/5 | 614 通过，7 跳过 | 11 → 11 | 142.300 → 141.142 | 0.427272 → 0.394763 |

fs-extra 请求数下降 50.0%，耗时下降 26.5%，完整参考费用下降 45.4%。ShellJS 请求数相同，耗时下降 0.8%，参考费用下降 7.6%。Commander 请求数增加 47.4%，耗时增加 56.0%，并且仍未满足全部已知兼容约束。

三组累计：基线 48 次请求、653.693 秒、完整参考费用 $2.241446；候选 48 次请求、735.471 秒、已知费用 $2.356817，另有一次用量未知。候选累计耗时增加 12.5%；缺失用量不能按零计入。六次运行共 96 次请求，95 次有用量，已知费用合计 $4.598262，完整总额未知。

两道冻结验证题未用于本次提示词修改；其中 ShellJS 与上一轮使用同一上游仓库，本轮任务是另一项功能。Commander 题目的后续默认分类已标为 `development`，历史冻结记录保持原样。每题单次采样、单一模型及服务时延、缓存和模型随机性都限制归因，不能将上述两个成功样本推广为通用能力提升。

## 3. 静态补审如何改变结论

上一轮 Commander 产物把已有 setter 的赋值广泛替换成重新定义属性，破坏了可写不可重新定义属性与访问器 setter。本轮 v3 在模型调用前加入这两种兼容约束。基线仍失败；候选通过普通键检查，但其 `__proto__` 分支对已有属性也使用 `Object.defineProperty`，再次破坏同类行为。

完成后的 v4 将三个兼容检查扩展到 `value`、`__proto__`、`constructor`、`toString`，覆盖普通值存储与 Command 属性存储。候选在 `__proto__` 上失败两项，原始项目的赋值语义可通过对应 setter 探针。因此 v3 的 9/9 不能认定为任务完整成功。模型原始代码没有被人工补丁覆盖。

人工修复正例在上一轮失败产物的独立副本中完成：只有新增的 `__proto__` 自有属性使用安全定义，已存在的属性继续赋值，保留描述符、setter 和只读错误。

```js
const values = this._storeOptionsAsProperties ? this : this._optionValues;
for (const [target, next] of [[values, value], [this._optionValueSources, source]]) {
  if (key === '__proto__' && !Object.prototype.hasOwnProperty.call(target, key)) {
    Object.defineProperty(target, key, {
      value: next, enumerable: true, configurable: true, writable: true,
    });
  } else {
    target[key] = next;
  }
}
return this;
```

此修复通过 v4 的 9/9，以及产物自身 1,371 项测试、ESM、JS/TS、tsd、lint 和格式检查。补丁及完整副本归档保留在本地证据目录。这是人工修复控制实验，不计作模型自主成功，也不是 Platform 中存在一个需要同样修改的 Commander setter。

初次 v4 的只读检查曾错误地要求属性存储模式下 `opts()` 本来不枚举的 `__proto__` 出现在快照中。最终修正为使用原 getter 核对 setter 结果、快照键与原 `opts()` 保持一致；初次 v4 日志保留，修正版另存为 `commander-v4-final-*.json`。两边原始 v3 评分保持原样。

fs-extra 与 ShellJS 的完成产物也审阅了实际差异：前者在原异步封装内选择 `lstat` 或 `access`，同步默认路径保留原行为；后者只在已有相邻分组结果上叠加单例过滤。两者均有永久测试、文档或示例改动，本轮复核范围内未发现额外兼容性缺陷。

## 4. 环境故障与回归验证

fs-extra 第一组并行准备时，原项目测试在系统临时目录使用固定的 `fs-extra/copy-broken-symlink` 路径，两个准备进程发生碰撞。一边预检通过，另一边 744 通过、1 失败、8 跳过；两边均未发出模型请求。隔离 attempt 临时目录后，重新冻结的两边预检均为 745 通过、8 跳过，随后才开始上表正式运行。原失败记录继续保留。

| 检查 | 结果 |
| --- | --- |
| Runtime、宿主指令、结束恢复、上下文整理与卷叙事回归 | 190/190 |
| 任务环境与冻结命令执行，包括并发临时路径隔离 | 21/21 |
| 增量构建、生成 Script 合同检查 | 通过 |
| 模块所有权、代码风格、lint、format、差异空白检查 | 通过 |
| 冻结候选与最终产品文件逐一核对 | 5,386 个文件一致 |

上一轮的 Script 165 项、Skill 16 项及类型检查已经通过，其被测实现没有后续修改。本次未执行完整仓库总入口 `bun run check`。人工控制副本首次格式检查还受归档解出的 macOS AppleDouble 元数据文件影响；仅清理该副本内已核验魔数的元数据文件后重新验证通过，原失败日志保留。

## 5. 结论与复现材料

基础运行时修复有直接复现和确定性回归，可以交付。简短收尾要求可以保留为行为规范，但本轮未证明它能稳定改善整体效率或自主交付质量。评测中的 `completed`、功能验收通过和满足全部任务要求必须分别记录；静态复核与独立动态验收继续共同决定结论。

本地完整证据：`.velaros-workspace/bench/runtime-review-20261006/`。

- `comparison.json`：六次运行指标、费用覆盖率、原始评分和补验并列记录。
- `validation-freeze.json`、各 attempt 的 `freeze.json`、快照 `manifest.json`：任务、评分器、环境与候选身份。
- `final-integrity.json`：候选冻结内容与交付文件核对。
- `commander-v4-final-*.json`、`post-run-descriptor-audit.json`：补充兼容检查；原始 v3、初次 v4 各自保留。
- `commander-compatibility-repair.patch`、`repair-control-checks.log`、`repair-control-workspace.tar.gz`：人工修复及验证。
- 各正式 attempt 的 `metrics.json`、`model-final.txt`、`scriptact/requests/`、轨迹、验收、回归与 `workspace.tar.gz`：原始模型产物与完整运行证据。
- `scratch-archives.jsonl`：本次临时工作区归档身份和校验；原始失败的准备目录同样保留归档。
- `runtime-regression.log`、`harness-regression.log`、`build-final.log`、`contracts.log`、`ownership-final.log`、`lint-delivery.log`、`format-final.log`：代码验证。
