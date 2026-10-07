# model 域不变量登记

每一条都是本模块对外的承诺。改动或删除任何一条，都要在差量报告里点名并说明原来的承诺为什么不对；
新增一条同样要点名。

检验方式分五档，`check:module-ownership` 门会核对每一行的检验器是否真的存在：

| 检验方式 | 含义                                             | 检验器写法                    |
| -------- | ------------------------------------------------ | ----------------------------- |
| 测试     | `spec/acceptance.test.ts` 里有以该编号开头的用例 | `spec/acceptance.test.ts`     |
| 类型     | 由类型定义钉死，改不了                           | `src/<文件路径>.ts::<类型名>` |
| 门禁     | 由仓库门禁脚本机械核对                           | `check:<门名>`                |
| 运行时   | 实现里有断言，违反即抛 `INVARIANT`               | `src/impl/<文件>.ts`          |
| 文字     | 目前只有文字描述，没有机器检验                   | 留空                          |

文字档在模块卡片的健康栏里显示为「未验证」，不算通过。编号只增不重排。

| 编号   | 不变量                                                                                                                                                                                                           | 检验方式 | 检验器                    |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------- |
| INV-1  | 解析只在同一个 provider 内回退模型，绝不换 provider：provider 不可用一律报错并给自救动作                                                                                                                         | 测试     | `spec/acceptance.test.ts` |
| INV-2  | 没有模块级单例：两份运行时对象图之间 provider script、Cloud 绑定、目录缓存一概不串                                                                                                                               | 测试     | `spec/acceptance.test.ts` |
| INV-3  | 未注册的 Cloud 服务直接报 `cloudNotConnected`，不回落 OpenRouter，也不换另一个 Velar 服务                                                                                                                        | 测试     | `spec/acceptance.test.ts` |
| INV-4  | 可移植面不发现宿主进程：`modelCatalog` 的环境值只能由调用方显式给，本包从不读 `process.env`                                                                                                                      | 测试     | `spec/acceptance.test.ts` |
| INV-5  | 缺凭据是错误码不是文案：`ModelErrorCodes.credentialMissing`，调用方按码分支                                                                                                                                      | 测试     | `spec/acceptance.test.ts` |
| INV-6  | agent 侧入口收 `unknown` 并在那里一次性收窄：形状不对当场拒绝，不做业务回退                                                                                                                                      | 测试     | `spec/acceptance.test.ts` |
| INV-7  | 内核 wire 面只开 `supports_provider` 一条操作，入参严格解析，未知字段当场拒绝                                                                                                                                    | 测试     | `spec/acceptance.test.ts` |
| INV-8  | 静态目录与常量表始终一致：每个内置 provider 的缺省模型、清单与目录逐条对得上                                                                                                                                     | 测试     | `spec/acceptance.test.ts` |
| INV-9  | token 账本永远非负；缓存读写分项独立计价；缺失单价或用量时完整费用保持未知并保留已知小计，不按其他模型约价                                                                                                                                                 | 测试     | `spec/acceptance.test.ts` |
| INV-10 | 文件分工与对外边界不塌：合同、类型、常量分开且接口成员有中文说明；实现一类一文件、类实现接口、按登记分层引用；utils 只放带中文说明的函数与常量；对外入口只转发，类、utils 函数、内部接口不出包；环境变量全部登记 | 门禁     | `check:module-ownership`  |
| INV-11 | `./catalog` 与 `./contracts` 的整条引用链不碰 Node 内置模块、不读宿主进程环境；根入口不出任何类                                                                                                                  | 门禁     | `check:model-arch`        |
| INV-12 | 供应商凭据验证复用 Model 协议：缺密钥不发请求，OpenRouter 使用鉴权端点，超时包含错误正文读取                                                                                                                     | 测试     | `spec/acceptance.test.ts` |
| INV-13 | 思考摘要只转给宿主展示：同一条响应只认一路来源（SDK 思考分片或 Chat Completions 原始分块），分段之间空一行；超出上限只停转发，不判失败                                                                           | 测试     | `spec/acceptance.test.ts` |
| INV-14 | 型号不认思考参数时往下退档重发、退到底不带思考参数，能用的档在同一份运行时里记住；与思考档位无关的 400（含加密状态、签名、reasoning.context）原样交出，不重发且不污染记住的档位                                                                                              | 测试     | `spec/acceptance.test.ts` |
| INV-15 | 会话缓存键只发给认它的线路：OpenAI 官方直连与 OpenRouter 译成 `prompt_cache_key`，其余适配器（OpenAI 兼容、DeepSeek、Anthropic、Google、Velar Cloud、脚本与自定义）只剥掉内部标记、不出线                        | 测试     | `spec/acceptance.test.ts` |

| INV-16 | GPT-6 Sol 经正式 Responses 适配器传递用户选择的 high / max 推理档位，移除不兼容的采样参数 | 测试 | `spec/acceptance.test.ts` |
| INV-17 | 官方 HTTPS 端点的已知型号默认将内部缓存断点译为 Responses 内容块断点；兼容端点由宿主显式声明支持，配置优先于默认值，会话键独立保留。先保留调用方已有断点，再按剩余槽位选择最近的内部标记，默认隐式模式下不突破三个显式缓存槽 | 测试 | `spec/acceptance.test.ts`、`test/prompt-cache-estimate.test.ts` |
| INV-18 | 原生 Responses 完整文本响应的加密推理和消息阶段按原顺序保存；仅同驱动、同供应商型号和完整原文匹配时以 store=false 重放，截断响应不发布状态，密文不按文本字节计费估算且其容量不受文本校准缩小 | 测试 | `spec/continuation.test.ts` |

| INV-19 | Responses 缺少终端的 EOF 保留部分正文、用量未知并标为可恢复中断；失败终端按明确的瞬时机器码或仅含机器码的诊断给出有限重试资格，永久错误码和取消优先，未知错误不猜测；终端已报告用量在后续失败时仍保留，真实失败文案和拒绝原因不被笼统 other 覆盖 | 测试 | `test/stream-interruption.test.ts` |

| INV-20 | 内置 OpenAI Responses 收到完整 completed/incomplete/failed SSE 终端后向 SDK 正常 EOF，usage、continuation 和错误仍由 SDK 校验；只将终端尾 CR 补 LF 为等价分隔符，不等待无关传输尾流；单事件原始字节上限 16 MiB，超限失败，半帧不算成功，取消清理不阻塞终端 | 测试 | `test/responses-terminal.test.ts` |

| INV-21 | 原生工具定义参与请求快照与指纹，驱动只交付完整且已声明的调用；Responses 与 Chat 的调用/回执逐一匹配，已绑定的结果正文原样进入工具回包并只发送一次，保留缓存断点，未绑定时使用原回执；延续状态不能隐藏额外动作；请求估算文本的 UTF-8 字节分项可加总。已知编码的路由用无图真实输入校准 BPE 与附加开销；已见长度内比较覆盖全部样本的增长与固定开销上界，范围外不外推趋势，保留文本计数下界、10% 余量与独立不透明容量，编译器不二次缩小；超窗重置且旧代迟到用量不恢复校准，真实用量独立记录 | 测试 | `test/native-tools.test.ts`、`test/input-estimator.test.ts` |
