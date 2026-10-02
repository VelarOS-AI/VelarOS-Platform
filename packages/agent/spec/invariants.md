# Act 不变量

旧合同迁移理由见 `docs/engineering/agent-test-migration.md`；编号延续已有登记。

| 编号 | 不变量 | 检验方式 | 检验器 |
| --- | --- | --- | --- |
| INV-16 | 可移植合同入口不加载 Node | 门禁 | `check:agent-browser` |
| INV-18 | 实现、注入、数据和公开面归属唯一 | 门禁 | `check:module-ownership` |
| INV-19 | 公开破坏性变更需要主版本和基线 | 门禁 | `check:agent-public-api` |
| INV-29 | 不响应取消的驱动不能无限阻塞循环 | 测试 | `spec/acceptance.test.ts` |
| INV-30 | 并发额度在派发前占位；子任务不占写入范围 | 测试 | `spec/acceptance.test.ts` |
| INV-31 | 子任务身份和配额可重启恢复 | 测试 | `spec/acceptance.test.ts` |
| INV-32 | 父取消传播并保留部分结果 | 测试 | `spec/acceptance.test.ts` |
| INV-33 | 并发失败不覆盖已完成任务的事实 | 测试 | `spec/acceptance.test.ts` |
| INV-34 | 一个收尾阶段失败仍尝试其余阶段，完成事件等待收尾成功 | 测试 | `spec/acceptance.test.ts` |
| INV-35 | 接受事件不能持久化时不派发脚本 | 测试 | `spec/acceptance.test.ts` |
| INV-36 | 子结果落盘故障必须传给父等待者 | 测试 | `spec/acceptance.test.ts` |
| INV-37 | 新输入从到达时抢占旧响应，轮边界等待输入持久化 | 测试 | `spec/acceptance.test.ts` |
| INV-38 | 子任务交付内嵌事件有界并声明省略量；没完成就结束的状态（容量受阻等）不能变成普通完成 | 测试 | `spec/acceptance.test.ts` |

| INV-39 | 输入接纳与消费分别持久化并带宿主身份；消费绑定具体请求，取消保留未消费输入，重启后只消费一次，回执写入失败不派发模型 | 测试 | `spec/acceptance.test.ts` |

| INV-40 | 容量规划按供应商实测用量校准估算（带图或不透明状态的请求不取样、超窗拒绝后回到原始估算），按同段同底座、同一布局（是否保留此前的帧）的正向增长估计剩余轮数；两次封段过近记为抖动（容量退卡不计），同一段的整理只跑一次 | 测试 | `test/context-planner.test.ts` |
| INV-41 | 每小时模型用量到上限时发 throttled 并等待后继续；用户总上限到了以 waiting 暂停，输入保留给下一次运行 | 测试 | `spec/acceptance.test.ts` |
| INV-42 | 一段里缺页持续偏高按结构性超载处理：同一段只跑一次压力整理，ContextStatus 给出收紧工作集的建议 | 测试 | `spec/acceptance.test.ts` |
| INV-43 | reasoning 展示事件跟在所属 turn 之后交给宿主，不写入材料或事件账；完整供应商延续状态按 INV-46 独立保存 | 测试 | `spec/acceptance.test.ts` |
| INV-44 | 同一会话的每个模型请求（含协议修复重发）都带同一个会话缓存键：会话 id 的 SHA-256 前 32 位十六进制，长度与会话 id 无关，碰不到 OpenAI `prompt_cache_key` 64 字符的上限 | 测试 | `spec/acceptance.test.ts` |
| INV-45 | 模型实测用量随 usage 事件交给宿主并存入 model-response 审计：供应商报告了前缀缓存的读写 token 时一并带上，没报告时不带 | 测试 | `spec/acceptance.test.ts` |
| INV-46 | 延续状态只在模型完整结束且协议通过后持久化，由已接受响应引用；拒绝、截断、重复或模型身份不匹配的状态不能进入历史，状态持久化失败不得派发脚本；不透明数据不成为宿主展示事件 | 测试 | `spec/acceptance.test.ts` |

| INV-47 | 瞬时模型故障只在响应尚未接受时有界重试，每次请求独立计数与审计；重置解码器，保留被拒绝原文和未知用量，不执行该帧或重放先前副作用，取消与永久错误不重试 | 测试 | `spec/acceptance.test.ts` |
| INV-48 | 提供增量渲染时，每个请求原样延续上一次被接受请求的实际出线（历史与最后一条帧消息），只追加新条目和只列变化的增量帧；逻辑历史被改写时整帧重发并重新开始保留；放不下或剩余轮数不足先放弃保留、再退卡、再封段；断点不随轮数累积 | 测试 | `spec/acceptance.test.ts` |
| INV-49 | 提供实际历史核对钩子时，先选择本次真正保留的历史再核对当前正文；所有容量与恢复重组重新核对，正文、实际提示和保留帧一致；只有完整响应接受且协议通过后才消费交付状态 | 测试 | `spec/acceptance.test.ts` |

| INV-50 | 协议修复请求沿用普通帧的当前实测校准，并按追加诊断后的完整请求重新准入；真实超窗仍拒绝，供应商超窗仍清空校准并重组，拒绝响应不派发或进入接受历史，修复估算挂起也服从取消与截止时间 | 测试 | `spec/acceptance.test.ts` |
