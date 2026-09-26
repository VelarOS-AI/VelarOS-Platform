# 0024: 模块不用申请

- Status: accepted
- Date: 2026-09-27
- Owners: `@velaros-ai/velaros`（`velaros:interaction`、`velaros:modules`）

## Context

`velaros:interaction` 有一个 `capability`：模型说明缺少什么能力，调用停在那里等人回答。回答本身不授予任何东西，
模型能用的模块在会话打开时就定了，用户在卡片上也没法挂上一个模块；子任务从 ADR 0018 起直接继承父任务的全部能力，
向父任务要能力同样无事可做。真机上模型找不到 `velaros:files` 时就用它弹了一张「需要挂载 velaros:files 模块」的卡，
带着一段 JSON，整轮停在那里等一个谁都给不了的批准。用户的裁决是「模块加载不需要审批」。

## Decision

- 去掉 `velaros:interaction` 的 `capability`（连同 `CapabilityRequest`）；模型面只剩 `ask` 与 `confirm`。
- `velaros:modules` 的说明写明：列出来的模块直接 import，不用申请；列不出来的这个会话装不上，换现有的能力做，或者在回复里说明缺什么。
- Act 运行时发起交互的种类只剩 `input` 与 `confirmation`。`@velaros-ai/agent` 的持久化请求类型照旧认 `capability`：
  升级之前落盘、还没答的请求照常读得回来，宿主照常收尾。

## Alternatives

- **保留 `capability`，由宿主自动回答**：调用变成一句固定的「没有」，模型白花一轮，还不如直接看 `modules.list`。否决。
- **宿主按申请现挂模块**：宿主在会话打开时就把这个空间该有的模块都挂上了，没有「装着但没挂」的模块可挂。否决。

## Security and privacy

不影响危险命令确认与空间边界；少了一种等人回答的请求。

## Compatibility and migration

模型面 `baselines/script/interaction.d.ts`、`modules.d.ts` 与代码模版已重新生成；还在调用 `capability` 的程序过不了检查
（没有这个导出）。宿主不用改接口；界面上旧记录里的能力申请卡照常显示，不再摊开附带的 JSON。

## Validation

`act/agents` 验收里声明与常量表的核对改成 `confirm` 的说明；模版逐个函数跑的用例随模版一起更新。

## Consequences

模型缺模块时不再停下来等批准：要么用现有的能力做完，要么在回复里说清楚缺什么。
