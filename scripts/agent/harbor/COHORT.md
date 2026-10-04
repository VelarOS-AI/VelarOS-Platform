# 原验证组首次对照进度

数据来自保留的首次源任务与官方重放。候选版本按行显示；原始失败、修复复测、费用均保留在各轮报告。不同候选和协议不合并为当前版本总胜率。

| 任务 / 轮次 | ScriptAct 候选 | 官方分数 C / S | 请求 C / S | 解题秒 C / S | 费用 C / S |
|---|---|---|---|---|---|
| NodeBB / 35 | raw-output-v1 | 1 / 1 | 17 / 10 | 153.49 / 182.81 | $0.296645 / $0.279808 |
| Ansible / 25 | compact-frame-v1 | 1 / 1 | 17 / 22 | 248.33 / 197.51 | $0.307466 / $0.530197 |
| Element Web / 27 | request-economy-v1 | 1 / 1 | 24 / 21 | 368.34 / 418.56 | $0.459571 / $0.674174 |
| Flipt / 38 | redis-daemon-v1 | 1 / 1 | 20 / 9 | 415.79 / 540.84 | $0.313852 / $0.279382 |
| Vuls / 40 | verification-scope-v1 | 1 / 1 | 31 / 17 | 490.33 / 524.74 | $0.585607 / $0.519936 |
| OpenLibrary / 42 | output-redistribution-v1 | 1 / 1 | 29 / 11 | 352.00 / 237.73 | $0.451312 / $0.364820 |
| Navidrome / 43 | output-redistribution-v1 | 1 / 1 | 14 / 11 | 194.58 / 231.08 | $0.214513 / $0.296000 |

C 为 Codex 0.158.0，S 为该任务首次封存的 ScriptAct 候选。Ansible25、Element27 的 Codex 使用历史 WebSocket 回退配置，真实耗时保留；当前协议为显式 Responses HTTP。

Teleport：原 Codex verifier 因本机 TLS 兼容问题失败，同一补丁在环境修复后通过且新增 0 次模型请求。ScriptAct 在修复后的源环境中运行并通过；双方源环境不同，该题不作严格效率胜负判断。

修复复测另外记录：NodeBB36/37、Flipt39、Vuls41，以及早期各轮记录。Vuls41 比 Vuls40 的请求、时间和费用均增加；OpenLibrary42 为当前 output-redistribution-v1 的独立新题，三项均优于该题原 Codex。

Navidrome45 同题指引优化复测：code-read-v1 官方 reward=1，9 次请求、173.061290 秒、$0.2428769。相对原 ScriptAct43 三项分别降低 18.18%、25.11%、17.95%；相对原 Codex43 请求和时间降低，费用仍高 13.22%。保留原三次完整结果，独立题数不变。轨迹仍有重复读取，且模型没有采用 code 正文拆分或 memory.read 补读；一次回执对象误标 text 的失败计入全部时间和费用。code-read-v2 的后续同题成绩见下方第 46 轮。详见 完整对照报告（`.velaros-workspace/bench/sol-scriptact-codex-validation-45-report.md`）。

Navidrome46 按用户要求验证 code-read-v2：官方 reward=1，11 次请求、213.408447 秒、$0.3688909。相对 v1 请求、时间、费用分别增加 22.22%、23.31%、51.88%；相对 Codex 请求更少，但时间高 9.67%、费用高 71.97%。4 个 code 正文块实际交付，0 次输出类型脚本错误，0 次归档补读；首个回复有 3 段相同探查程序，重叠读取仍存在。全部原始四次结果保留，独立题数不变，当前不将 v2 标为效率改进。完整四组对照报告（`.velaros-workspace/bench/sol-scriptact-codex-validation-46-report.md`）。


Navidrome47 字段补读修复复测：field-read-v1 官方 reward=1，9 次请求、195.277362 秒、$0.2962006。相对第 46 轮请求、时间、费用分别降低 18.18%、8.50%、19.71%；相对 Codex 请求少 35.71%，时间高 0.36%，费用高 38.08%。字段补读本地功能验证通过，真实尝试调用为 0，不能归因整题改善。136 项相关回归与三段真实归档离线回放通过。五次原始尝试保留，独立题数不变。完整五组对照报告（`.velaros-workspace/bench/sol-scriptact-codex-validation-47-report.md`）。

Navidrome43 双方首次源任务与官方重放通过；ScriptAct 请求更少，耗时与费用更高。接下来按原顺序进入 Proton WebClients、Qutebrowser、Tutanota，完成后进入 HARD-51。

本次数据与原始清单摘要：JSON 审计证据（`.velaros-workspace/bench/campaign/validation-43-cohort-completion-audit.json`）。

HARD-51 顺序已根据官方 ID 与元数据固定，共 51 题、11 仓库，固定种子的仓库轮转，准备新增 0 次模型请求：HARD-51 顺序清单（`.velaros-workspace/bench/campaign/hard51-order-v1.json`）。每题的候选及环境将在 Oracle 前另行固定，模型预算共享同一 $1,000 上限。
