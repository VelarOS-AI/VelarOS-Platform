# 授权、生命周期与材料完整性差量（2026-11-09）

接续 `4198b12c`。26 个治理模块已经完成整模块静态阅读；覆盖台账把阅读、已修、待验和合理保留分别记录，不能据此宣称所有候选或动态平台验收完成。正式 `v0.7.3` 的 0.9.2 归档、身份及回执继续冻结。

## 本轮差量

| 范围 | 原问题与处理 |
| --- | --- |
| Kernel | 模块替换登记完整在途流程，关闭拒绝准入并排空暂存回滚及旧代释放；Launcher 拒绝迟到选版、关闭迟到连接；远程节点凭据 save/clear 串行，解除配对使旧尝试失效，不能重新授信。启动读取及监听的关闭归属继续沿同一资源 owner 收束。 |
| Context | 历史 artifact 可以保留历史版本，但必须继续通过当前来源授权；活动账本的条目与已知 inspect 外壳在存入、返回和 peek 时分离，调用方不能改写已定稿正文、标签或序号。未知 argsHint 仍作为宿主不透明值，不新增深克隆限制。 |
| Runtime/System | trace 页预算计入项目差量正文；关闭等待合作取消端口的物理清理后才释放资源和存储；store.share 复用 memory.read 的同一材料授权 gate，保留当前目标及显式重新附加例外，拒绝旧任务原文时不创建共享正文。 |
| Project | 已应用事务即使被历史预算淘汰仍返回实际提交回执和效果；AfterSearch/AfterResolve 的原错不落入后端回退 catch；读取失败不伪装为空文件。引用与影响分析传递截断事实，逐行正则复用现有受时限执行口并按剩余额度读取匹配。Git 撤销只在 canonical 索引锁内发布当前仍属 intent-to-add 的私有索引，保留真实暂存；进程未证明结束时保留私有诊断，宿主日志抛错也继续释放自有锁。 |
| Browser | 页面换绑退休自身协议、引用、监听与输入登记；取消信号跨队列及资源流读取传递，输入部分失败不整段重放。修复唯一 selector、拖拽最终坐标、Shift 键、启动器原生失败、在飞网络请求与上传 debugger 租约。下载决策失败保留待处理状态，实际落盘后才发布完成；流读取使用既有字节上限并在写入前重查路径。堆快照逐块写入独占临时文件，等待驱动 Promise 结算再关闭 sink 和发布。 |
| Model | 公开 provider 描述符只含稳定、深冻结的纯数据，同代缓存继续命中，新注册仍使缓存失效。仅上传的同步适配器将 Promise jobs 纳入 VM 执行时限，受信异步 ProviderScript 路径保持原契约。 |
| Agent lab | 空错误消息也阻断失败的驱动预检；CLI 保留等号后的完整值；每次发送前刷新完成基线；重复 runId 明确拒绝，歧义配对报告不可比，不能重复计数或按输入顺序挑最后一项。 |
| Features/Office | Features 模型文档补齐既有 ID 与路径限制；Office 自动演示不再裁掉页、标题或封面正文。超过自动版式容量时，在任何空间访问与写入前明确拒绝。 |
| Core 与公共错误 | 29 处产品原生错误构造改为 AppError；聚合错误保留顶层 errors 的元素身份与顺序，已有两处领域码保留，不新增 cause 链。真实 AppError 子类继续原样返回，文件日志在 IPC toJSON 之前保存嵌套诊断、循环与自定义普通数据序列化行为。 |

## 公开合同与承诺

- Office 自动文本最多 200 页，单页标题最多 200 字符、正文最多 2800 字符，超过时要求显式分页或缩短标题。2800 从内部版式 tuning 移到公开输入常量 `OfficeInputLimits.presentation.autoBodyChars`，校验与 AgentView 文档引用同一值；合法的 200 字标题及封面第五行以后正文完整保留。这是对原先静默裁剪行为的明确收紧，不是自动生成额外页面。结构化 slides 的合同保持原样。
- Features 只补既有 214/4096 上限文档。上述模型声明与 baseline 由 TS 接口生成，不能手改。操作签名及效果不变。
- Model descriptor 返回值现在不可变；需要编辑清单的宿主应先复制。descriptor 的执行 helpers/definition 本来就不属于公开纯数据合同。没有新增公共入口或缓存身份端口。
- Agent lab 同一批统计或认证证据的 runId 必须唯一，JSON 复制或重复加载同一归档不能成为新的尝试；不同 runId 的真实复跑仍可计数。成对比较同一执行体、同一配对键存在多个运行时明确不可比，不改变公开签名。
- Kernel、Context、Runtime 和 System 的变更落实已有授权、原文完整性及资源所有权承诺，不扩大宿主权限。
- 聚合收尾错误现在是 `AppError`，通用码 `UNAVAILABLE`，原 `errors` 字段继续直接可读；`SEARCH_CLEANUP` 与 `MODEL_RESERVATION_RELEASE` 保持原码。三处自定义参数校验改为 `VALIDATION`。外部 JSON 解析等原生异常继续原样传播，未新增原生错误工厂。AST 门覆盖七类标准 Error、调用及带括号的 globalThis 属性/下标形式，既有例外及理由未扩大。
- Skills 的共享宿主与合法 SDK 调用复用同一 Kernel 授权。保留现有 factory，不能把测试产品的 grants 并集当作 SDK-only 模型入口策略；入口与派生调用的更细策略是宿主合同设计边界，当前未承诺或新增这种模式。
- Browser 的 `handled/accepted/savePath` 表示下载决策已受理及请求的目标，`done completed` 只在目标落盘后产生；失败使用既有 `interrupted` 状态，没有新增完成字段。driver 资源读取端口增加可选 `signal`，模型操作签名与效果不变。50 MiB 是已有资源下载上限，不套用到堆快照。堆快照取消停止本地写入并等待原驱动调用结算，不新增驱动物理停止端口或声称中止 V8 采集。
- Browser 用户脚本执行面变化时先可靠读取旧代码并持久停用，再替换代码与索引。后续失败保持停用并保留原错与回滚诊断，修订后的 INV-34 明确这一失败承诺；成功启用仍服从宿主授权策略。INV-35 明确堆快照流式写入、Unicode 字节计数、驱动排空及自有临时文件清理。allow-list 文档校准为现有拒绝列表语义，未增加权限。

## 工具链与安装入口

声明版本沿 `package.json` 的 `bun@1.4.3` 单一来源。三个工作流共用本仓 composite action：按声明查官方 GitHub release，再从官方 release asset API 单入口下载，校验该 release 返回的 SHA-256 与实际 Bun 版本。没有镜像或多路 fallback，安装位置是本次运行独有目录。

安装入口独立提交为 `97fb61ca`；正式发布工作流从 main 加载，其最小入口更新为 `5240b1b8`，只包含 release 工作流及 composite action，没有合入清理分支。下一次统一归档版本是 `v0.7.4` / 基础包和能力包 `0.9.3`；root、workspace 清单、锁文件、Project 身份常量及生成包目录同步，平台代仍为 0.7。

已核对官方 1.4.3 Linux x64 资产：ID `626788717`，SHA-256 `3e730528d89775f03f87f05c06787c4df4099d0a37f3f252e7b829cb23816e18`，与 Server 已成功使用的[工作流](https://github.com/VelarOS-AI/VelarOS-Server/blob/165139c90caaeab917fd9920985ff070c619ca7a/.github/workflows/linux-install.yml)一致。action 自身按声明动态解析资产，不另写版本常量。三个工作流及 action 的 YAML 解析、安装脚本 `bash -n` 已通过；本轮尚未在 Linux 执行新的安装步骤，不把静态检查写成正式 CI 通过。

## 验证状态

已通过 12 个源码定向用例；基础七包依赖拓扑构建通过，其后 20 项定向检查通过，含两项 AST 门回归与全产品当前构造检查、八项 Core 断言、四项 Kernel 生命周期、三项 Model（真实 Node VM）、一项 Agent、两项 Node Context 用例。文件日志最后保留普通对象自定义 toJSON 的细调仅重核相同一例并通过，其余绿项保留。Core 额外 34 个生产文件、3212 行也已完成静态阅读，和 26 治理模块分别计数。

完整依赖拓扑八包构建、全量 `generate:script`、Act catalog 生成及统一格式已通过，用户受保护文件哈希保持原样。其后五个 Runtime/System Node 用例与真实 Node V8 正则时限用例通过。Git 索引完整 12 例通过，日志抛错细调只重核同一例并通过；堆快照小型流式 gate 通过。

Browser 第一批 26 例通过，另有一个资源测试替身补齐必需的 getURL 后定向通过。CDP 的 14 个定向用例及用户脚本既有三例通过；真实 Runtime→Launcher gate 证明下载结算前页面、连接和自有 profile 仍存活，派生 driver 不关闭借用的 target。既有模板执行用例在 Windows 因原平台条件跳过，未计入绿项；真实 Chrome/Electron 未运行。

累计 95 项不同的定向用例通过；全仓八个有类型脚本的包已通过 typecheck（Core 的两处测试类型表达单独修正后核验）。完整 `check:script` 的 17 项生成器/合同测试及全量声明校验、`check:act-catalog`、全部 26 模块 `check:module-ownership` 和改动 lint 均通过。最后职责归位将 Git 双视图的数据判定放入已有纯工具、把 Kernel 原始 socket 清理收进监听 owner，并给下载决策变化补明确冲突；随后仅重建 Kernel、Velaros，重核五个受影响分支并通过，不重跑已绿的完整 Script 检查。受保护原用户文件和暂存区保持独立，产品依赖未改。

此提交完成本轮源码修复与本地验证，下一步只有新源码的单次正式发布、精确归档摘要与最小包消费证明。Linux 新安装步骤、正式归档及三个产品集成的结果须以之后的 CI 和同摘要回执为准，不能用本地绿项代替。
