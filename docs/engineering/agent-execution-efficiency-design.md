# Agent 执行效率与失败恢复

2026-09-13；候选 Agent 0.6.27 / Project 2.0.23 / Agent Lab 0.1.4。

## 参数属于运行时，重试只表达差异

Project 的 edit/write 支持两种输入：普通完整参数；或者失败回执中的 `reuse` 加 `changes`。框架保存完整参数，模型无须重新生成大段正文。成功调用维持原有结果结构。

```json
{
  "reuse": "attempt:large-failed",
  "changes": [
    {"op": "set", "path": ["edits", 0, "oldText"], "value": "export const before = 1"}
  ]
}
```

`set` 设置字段，`remove` 删除字段或数组项。路径使用字符串/整数数组，省去 JSON Pointer 的额外转义。正文经过结构化复制，框架不猜测、不解码、不重写反斜杠或 Unicode。

执行顺序：

1. 根据会话、工具和 workspace 查找不可变参数与执行回执。
2. 来源必须已经结束且确证 `not-applied`。`completed`、取消后的未知结果和仍在执行的调用不能作为重试来源。
3. 校验变更路径，在副本上修改。禁止原型链路径、隐式父对象和越界数组索引。
4. 执行器持久化单次重试领取记录。同一失败来源只允许一个后续调用领取；并发重复领取被拒绝。再次失败会生成新的参数引用。
5. 完整参数重新经过当前 middleware、工具权限、原始 schema、审批和 Project revision/事务检查。
6. 执行器保存结果与输入字符统计，然后向模型发送可执行的恢复信息。

领取记录跨宿主重启保留；在宿主单进程拥有执行的模型下串行领取。它不替代 Project 的事务持久化，也不是跨多个独立宿主进程的分布式 exactly-once 协议。领取后进程崩溃，必须检查状态，不能自动重放。

归档服务不可用时，普通调用照常执行；框架不会提供无法兑现的参数引用。Desktop 的异步、同步 renderer 增量保存都保留参数、回执、领取记录和编辑定位引用；显式清空会话会清理这些记录。档案当前随会话保留，容量治理仍由宿主负责。

工具 schema 保持 object 根节点。完整参数的必填项和默认值仍由原始 schema 校验；复用分支不注入普通参数的默认值。写入工具保留独立的浅层合同预算，复用字段另有体积预算。

## 让返回值直接支持下一步操作

`project:read` 为完整行窗口返回 `editTarget`。模型可用：

```json
{"edits":[{"type":"replace_selection","selectionRef":"selection:...","newLines":["const value = 2"]}]}
```

引用绑定 workspace、路径、读取 revision 和实际行范围。框架转换为已有 `replace_lines` 操作，继续复用事务内核。文件被修改后，旧引用因 revision 不符拒绝覆盖。半行读取、字符截断到行中间、越界、脱敏、二进制和目录不发可替换行引用。历史读取结果压缩成回执时保留 `editTarget`。

## 根据证据判断是否仍在原地重试

执行器按资源、失败条件和版本记录连续失败。改动不相关参数、读取另一个文件不会清除同一障碍；对相同资源取得新的结果证据后重新判断。观察记录有界，达到阈值返回 `progressAdvice`。

建议保留原始错误、诊断与参数引用，不强制模型先写归责说明。现有批次重复检测也保留原始失败结果。进度识别是启发式建议，不能充当事务幂等或版本校验依据。

## 让有效验证结果可以复用

Validator 可声明 `cacheKey(input, context)`，明确承担依赖指纹的完整性。Registry 在一次校验中复用读取视图，仅缓存成功且所有 check 通过的结果，返回结果是隔离副本；每个 validator 最多 128 项，单项最多 256,000 个 JSON 字符。

TypeScript 语法校验已接入：实际文件路径与内容参与 SHA-256 指纹，workspace 单独隔离；源码不变时避免重复解析。未知依赖的外部命令、测试、类型检查仍执行。这一实现没有宣称通用测试缓存已经具备完整失效分析。

同时修复汇总缺陷：validator/adapter 返回 `ok: false`，或包含失败 check，即使没有错误诊断，最终结果仍必须失败。

## 把资源冲突交给运行时

同一宿主进程中，Project 读取共享执行，前台修改和有副作用的命令独占 workspace；等待中的写操作阻止后续读操作无限插队。不同 workspace 独立推进，等待取消不会启动操作。实际运行中的工作结束后才释放资源。

修改审批在进入资源队列前处理。可安全并行的只读命令默认允许并行，模型不必重复声明 `parallel: true`。后台进程生命周期继续由宿主 job manager 管理；这里不声称后台进程已被纳入完整资源调度。

## 衡量实际尝试，而不是隐藏失败

每次 edit/write 的回执记录 requestedChars、effectiveChars、reused 和执行结果。Agent Lab 的 `summarizeToolInputEfficiency` 从这些真实回执汇总：完整尝试数、未应用失败、成功、未知结果、复用次数和省去的重复字符数。

字符数用于复现输入减少量，不能等同实际 token、费用、缓存命中率或线上模型成功率。受控模型的集成回归与外部模型自然选择工具的评测应分别统计。

实现位置：Agent `tools/recovery/` 负责参数及进度；Project `agent/ProjectEditTarget.ts` 和 `ProjectExecutionGate.ts` 负责模型操作与资源适配；validator registry 负责验证证据；Agent Lab `workload/InputEfficiency.ts` 负责独立统计。
