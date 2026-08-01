# Desktop Agent Lab 替换与等价判决

本文件记录旧 `/tools/agent-lab` 与新包对同一语料的逐项判决。历史归档始终只读，不迁移、不补字段。

## 已知语义变化

旧 `analyze.mjs::latestDebugToolSnapshot` 把 `get_debug.turns` 的累积快照当独立轮次相加，未按
`toolCallId` 去重；真实样本出现 1106 对 69（16 倍）虚高。新协议把 measurement basis 固定为
`unique-tool-call`，这是“旧实现错误”，不是待兼容差异。v3 manifest 和 CHANGELOG 显式记录该口径。

## Detector 对应

| 旧 detector | 新归属 | 判决 |
| --- | --- | --- |
| stuck-streaming-block / stuck-running-tool / orphan-tool-call | built-in detector | 保留语义，统一 transcript 形状 |
| placeholder-leak / protocol-leak / empty-final-answer | built-in detector | 保留；相同观测得到相同结论 |
| context-estimate-sanity | built-in detector | 保留，未知字段不参与判定 |
| finish-truncation / finish-unknown | built-in detector | 保留，按 turn finishReasons |
| tool-failure / tool-retry-loop / toolmap-read-loop / turn-tool-density | built-in detector | 保留，并先做全局 toolCallId 去重 |
| awaiting-dangling | 产品 archive verifier | runtime 私有落盘字段不进入 host 无关核心 |
| manifest-unreadable | archive parser | 变为 `shape=invalid` + errors，不冒充 agent 失败 |
| dangling-registry-member / orphan-session-dir / session-dir-missing | Desktop registry verifier | 属于产品存储完整性，不属于通用 agent 能力 |
| debug-unavailable | observation coverage | 变为 turns/runtime coverage none/partial，报告未知 |

后五项是“职责重划”，不是删除观测。Desktop consumer 已在每条 Journey 的最终 leg 注册
`desktop-storage-integrity` verifier：会话本身的 manifest、目录、registry 归属和悬空等待是判决面；无关历史
孤儿目录只作为证据报告，不能污染当前 agent 能力分。实现位于 Desktop `dev/agent-lab/Verifier.ts`。

## 归档形状

| 形状 | 数量（替换前基线） | 新读法 |
| --- | ---: | --- |
| v1-flat | 46 | 只读字段投影；不存在的 drops/usage/context 为 null |
| v0-array | 6 | rounds 可读；passed/findings/drops 均未知 |
| 总历史归档 | 52 | 每份必须可读或给出确定的 invalid 原因 |

替换验收必须重新跑逐文件对照并把结果固定成机器可读清单。任何不一致只能是：旧的错、故意改变并有本文判决、
或新实现错误并修复；不接受“大致一致”。

逐件身份已固定在 `packages/agent-lab/test/fixtures/legacy-equivalence.tsv`：52 行分别记录原根、run 目录、被选
文件、原始字节 SHA-256 和形状。替换前最后一次验收使用：

```bash
bun packages/agent-lab/scripts/check-legacy-equivalence.mjs \
  --expect 52 \
  --snapshot packages/agent-lab/test/fixtures/legacy-equivalence.tsv \
  <desktop-tools-agent-lab-runs> <desktop-batteries-runs>
```

结果为 46 份 v1-flat、6 份 v0-array、0 不可读、0 字段差异；每份报告都通过自包含 HTML 渲染。TSV 只存
身份与判决证据，不是历史归档迁移或字段回填。
