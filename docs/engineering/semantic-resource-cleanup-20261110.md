# 资源归属与读取事实差量

本批承接前四轮语义清理，提交只进入 `codex/runtime-lifecycle-cleanup`，不合 main、不改变 0.9.5 版本或发行。26 个治理模块已全部整读，范围和保留理由见 [覆盖表](semantic-review-coverage-20261110.md)。整读不是要求每个模块都改；已通过的旧链路保留原证明。

## 行为差量

| 组 | 原问题与根修 | 合同影响 |
| --- | --- | --- |
| W1 Core Windows open | `cmd /c start` 再解析目标与参数；改用固定系统 PowerShell 的 UTF-16LE EncodedCommand，构造图形 `ProcessStartInfo.UseShellExecute`，FileName 作为字面量，Arguments 按原生 argv 引号规则编码 | CommandSpec 形状不变；合法 URL、空参、引号、反斜线、Unicode 与 target-first 顺序保留，NUL 明确拒绝；运行环境须有系统 Windows PowerShell。九仓未发现依赖旧 spec.file 的消费，不据此推断未知外部调用者 |
| K1 Kernel 启动/替换 | 同步重入关闭可能错过启动占有，替换同 ID 可重用代际混合服务；先登记完整 Promise，关闭先广播取消，迟到生命周期真实回滚；同 ID 替换占有持续到回滚或旧代释放完成 | 原 INV-6 的单代归属得到实现；内部重复替换报通用 CONFLICT，不增加根 Kernel API；不同 ID 可并行 |
| K2 Remote trust | 旧认证调用晚到可回填新信任缓存，取消只按调用号命中 | 调用/缓存按信任代、已认证客户端与调用号归属；撤信任不伪造真实调用完成，同信任重连回放保留；新增代次仅内部类型，不上 wire |
| K3 Launcher | 并发点火、spawn/kill 重入与有界 stop 后覆盖仍活 child | 串行确保启动、各 caller 独立客户端；仅真实 exit 后释放 child，超时保留 owner；外部附着进程仍不归 Launcher 杀 |
| C2 Context 首事件 | 无账本空基底的进程代与首写账本代不一致，首事件被当成旧代重置而丢弃 | 只衔接本实例空基底 afterSeq=0；只读不建账本，真实旧代清理/淘汰仍失配，不增加墓碑或第二份账本 |
| M1 UserJs VM | 导出 getter/Proxy、可变结果槽、console 序列化与异常诊断可在 VM 墙外执行 | 受控读取与格式化在原有执行预算中；宿主槽固定为数据属性，出墙 JSON 必须原始字符串；宿主异常不回流 VM。保留 named/default/getter/Proxy、原 source 顶层语义和 hook receiver，不引入通用沙箱框架 |
| A3 Agent 新任务 | 被取消任务的未消费输入在显式 task:new 后复活，宿主 inputId 被误作跨任务权威 | INV-39 明确取消/重启恢复的是当前任务输入；显式新任务按 startedSequence 截止，旧输入审计保留，继续原任务仍恢复未消费输入 |
| C3 Computer | helper/spawn 注入回调重入 dispose 后，迟到 sidecar 可重新发布 | 启动 Promise 先登记，所有准入点核关闭；迟到 child 独立回收，exit 监听先于 EOF；dispose():void 与 Python 资产版本不变 |
| B2 Browser runtime | 永久 dispose 后仍可接纳新页面/宿主操作；简单终态布尔又会阻止失败清理重试 | 使用 open/disposing/failed/disposed 单状态；非 open 拒新工作，failed 允许按原序再清理，原错保留。closeAllSessions 继续支持复用 |
| B3 Browser context | 高层目录忽略显式空 context，非空 context 中缺失目标也可继续附着 | 默认 context 用空串精确过滤，高层目录/切换只使用本次 context，缺目标失败并关自己创建的页；不把原始任意 CDP 命令宣称为安全隔离 |
| P1 Project 请求 | 沙箱源授权后等待期间原 options 或 paths 可变 | create/diff/run/apply 在授权与写 gate 前捕获实际有意义字段，授权与派发同一请求 |
| P2 Project evidence | 未知存储/后端 IO 被 canAccess 转为 false，撤掉仍合法证据与历史 | 只将明确 PERMISSION_DENIED/TARGET_NOT_FOUND 判不可访问，取消和未知原错传播；stat exists:false 的既有判定保留 |
| P3 Project 源码边界 | 语言动作将截断源码当完整，尾部唯一导入/引用可被报告不存在 | 完整源码 helper 遇 truncated/hasMore 报 NOT_SUPPORTED，不扩上限或形状；修正内部注释与 README |
| P4 Project definition | 独立 read 的 revision 被用于签署随后 listSymbols 的坐标，外部编辑/ABA 时证据虚假 | 后端符号没有解析快照 revision 时 coverage.versioned=false、revisions=[] 并说明降级；声明/正文/候选回退保留，不用前后同 hash 冒充解析快照 |
| R4 Runtime 准备故障 | prepareProgram/executeBatch 将存储原错降为 SCRIPT_REF 或无效果材料，模型仍可 completed；放行后还会被 Agent 的事件归一化边界吸收 | 仅确定的控制拒绝材料化，未分类基础故障进入 Runtime 既有故障记录；完整交付 error/failed 并完成真实 stop/end 后，迭代器重抛原对象。不改 Agent 公共事件合同或 observe 运行失败材料化合同 |
| O1 Office CSV | 先按物理行拆开导致引号内换行损坏 | 按引号状态读逻辑 CSV/TSV 记录，保留转义/CRLF/引号内空行；未闭合引号在任何空间访问与写入前 VALIDATION，既有转换与上限不变 |
| O2 Office PPTX | 按 slide 文件名排序和计数，忽略真实清单、关系与 XML namespace | 包级 officeDocument 定位主部件，按直接 sldIdLst 顺序解析内部 slide 关系；孤立页不计、空稿零页、先核全部目标存在再裁预览窗口。Strict/Transitional 与任意前缀保留，损坏关系/外部目标/DOCTYPE/XML 诊断明确拒绝；不宣称全包 schema 或布局验收 |

本批无模型操作签名、效果、模式、数值上限或生成声明变更，不手改 surface 或模板。新增 XML helper 为内部纯函数，XML parser 直接依赖仅由 Office 的静态 import 引入；共享开发清单不等同于基础发行闭包。

PowerShell 的 EncodedCommand 使用 UTF-16LE；UseShellExecute 指图形 shell 的文件关联。[PowerShell 参数](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)、[UseShellExecute](https://learn.microsoft.com/en-us/dotnet/api/system.diagnostics.processstartinfo.useshellexecute?view=netframework-4.8.1)。PPTX 页序由幻灯片清单决定，移动页不要求重命名部件。[Open XML 页序说明](https://learn.microsoft.com/en-us/office/open-xml/presentation/how-to-move-a-slide-to-a-new-position-in-a-presentation)。

## 验证与资源边界

统一证据目录 `.velaros-workspace/semantic-resource-20261110/`。本批 **53 个定向场景及必要邻例通过，失败 0**：Core 5、Kernel 16、Context 2、Model 4、Agent 2、Computer 3、Browser 5、Project 7、Runtime 3、Office 6。筛掉的未选测试不计入通过数。

Core、Kernel、Context、Model、Agent、Velaros 的构建与类型检查、差量 lint、`bun run format`、26 模块 ownership 和错误构造门禁均通过。校验只经既有跨仓 heavy-validation mutex、2048 MiB 顺序执行；未审为 0、已证实未修为 0、待验为 0。未跑全套、provider、真实浏览器或跨 OS 矩阵，不把静态整读和这些针对证明宣称为所有路径运行过。

前置校验发现并修正了一条测试 prefer-const、两处 Model 函数类型收窄和一处测试可空 Promise 比较。行为校验进一步发现 Runtime 原错还会被 Agent 归一化边界吸收，已在 Runtime 既有故障记录中补齐；夹具严格核对真实目标 get、原错身份、零目标执行与失败终态。另纠正了误用 Node 运行 Bun 测试的命令，并区分 CSV 原始 CRLF 与 ExcelJS 读取 XML 后的 LF；非 Node 假运行器按正式可省略 mode 合同验收，未吞掉夹具错误或撤去关键断言。ownership 要求的两个纯函数已移入既有 utils。后续只重验实际新差量或失败项，已绿构建、检查与旧批证明未无故重跑；Kernel/Velaros 在新源码修正后各补建和补类型检查一次。

Windows 测试只解析生成的 PowerShell AST 或启动隐藏、有硬期限的自身 argv 回显进程，不实际打开用户关联；恶意 VM 测试只在短硬期限独立 Node 子进程运行，不调用 provider。

新增 `@xmldom/xmldom@0.8.15` 复用既有锁定版本，离线 lockfile-only 的差量只有一行直接依赖，未升级依赖。构建后用现有 stageUnifiedPlatformPackage 直接生成两份真实清单：基础包的 dependencies/optional/peer/bundled 均没有 xmldom 或 mammoth；capabilities 明确包含 xmldom 0.8.15、mammoth 1.12.0，并以 peer 指向同版本 0.9.5 基础包。未打包、发版或跑安装矩阵，未修改原 D 的 node_modules/dist。

Browser 协议注册层只按 sessionId 退役映射并 best-effort detach，open Symbol 不能表达页面关闭意图或同页显式新协议。未给通用层加永久失败墓碑、自动重试、协议 Runtime 重建或新公开动作；真正持页面代和关闭意图的产品 owner 保存完整关闭 Promise，新页面建立新 owner，onClose 不改写旧票结果。MCP 已受理 token exchange 由宿主持有，现 transport.close 不承诺等待或中断；这两处保留理由已有限定案，不留作无限候选。

## 独立提交

| 模块 | 提交 |
| --- | --- |
| Core | `85c34344` |
| Kernel | `166fc2c4` |
| Context | `f7e3a4b8` |
| Model | `fd6f4b34` |
| Agent | `fc0b9a35` |
| Computer | `ebf3bbd2` |
| Browser | `e9a58929` |
| Project | `2790fe5f` |
| Office | `25f0b6ea` |
| Runtime | `2c661e76` |

原 D 工作区已在交付前复核：仍为 `codex/platform-foundation` / `2726dd8f06389b121f033b8ff1d47a8cb3198461`，只有原有用户测试空行；该文件与原 index 的 SHA-256 均未变。main 仍为 `70e93a2b8c020ad7509a9fb2d8eb3f7a754664a7`，未合并或发行。
