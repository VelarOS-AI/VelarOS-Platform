# Platform 显式基础与能力发行差量

日期：2026-11-09。实施基线：`801603b020fa906ef5499372d05f4e6755beef98`。本批为平台代 `0.7`、基础及扩展版本 `0.9.0` 的本地可审阅切换，不代表远端发布或产品接入完成。

## 公开合同与行为

| 改动 | 理由与影响 | 验证 |
| --- | --- | --- |
| `createRuntime` 要求 storage、binding、node/runner 之一；model 只接解析后的 ModelDriver | 核心只装通用运行机制，拒绝重复执行 owner；注入连接的成功/失败所有权不变 | 源码构建、严格实际声明消费 |
| 删除 workspace/project/skills/dataDir 与布尔能力预设 | 路径、模型和状态目录不再授予项目、图像、搜索、子任务、长期记忆或包管理；旧 JS 配置也显式拒绝 | INV-30、实际基础消费者的缺席能力检查 |
| `/node` 提供 createNodeRuntime 与 createNodeExecutionEnvironment | 复用既有 LocalShellHost、Node 执行和唯一 Runtime；本机策略显式选择，借用 Host 仍归产品；Node 最低版本收紧到本轮环境 24.22.0 | 普通 Node 独立 JS 消费、命令/文件/交互/取消/恢复 |
| binding 固定宿主 executionIdentity、authorizationScope 和实际全部模块绑定 | 核心不解释产品 root；Node 环境固定真实执行目录、执行用户与可执行文件。产品恢复仍须核验自己的成员、授权根与资源映射 | INV-39；初始化、重开、变化拒绝 |
| resources 成功后移交、完全 drain 后关闭；moduleAccess 同时裁剪发现和派发 | 单一资源 owner；宿主可以显式组合 Skills 的授权目录，无核心 Skills 预设 | INV-47 的非合作写、关闭超时与失败初始化所有权 |
| 项目三工厂迁到 Project；新增结构注入的 createSkillProjectCodeQuery | 领域工厂不再污染基础值/声明闭包；保留原语言所有者重核验和激活机制，不复制实现 | 类型构建、显式项目事务消费者 |
| ContextPatchStore.get 明确返回 Nullable 类型 | 消除 TS 推导泄漏仓库私有 packages/context/dist/internal 路径，不改变运行行为 | 发行 AST 闭包门、严格声明消费 |

没有新增模型操作、手写 Schema 或模型能力版本；已有生成模型合同和模板继续复用。包目录生成清单同步到新版本、平台代和 Node 入口。Runtime、Project、System、Search、Agents、Execution、Memory、Skills README 同步显式装配；33 段 README 示例通过真实公开类型检查。

## 验收承诺变化

- INV-30 从声明式产品预设改为显式 Node/Project 组合，仍证明唯一主干、源码保存与重开恢复。
- INV-39 从产品 workspace 真实路径改为通用执行身份、授权与能力绑定。旧 `runtime:workspace`、缺少绑定的已有历史、损坏和重复绑定均拒绝；不自动迁移，不静默扩大权限。产品须核验后迁移或创建新会话。
- INV-47 保留非合作写的真实收束承诺，并明确 resources 不能在 close 超时后提前释放。初始化失败不夺取调用者资源。
- 观察复用原先容许更换模块 generation 后继续同一会话；现在能力绑定变化首先 CONFLICT，避免历史在另一资源代际恢复。相应既有验收已调整，未以删除测试规避检查。
- 持久 npm 环境不再从 dataDir 推导。长期记忆、搜索和业务子任务同样只在显式配置时挂载；上下文正确性机制保留。

## 发行与消费者

基础 `@velaros-ai/velaros@0.9.0` 包含通用运行、Node 环境及 core/kernel/model/agent/context/script 公共子路径。扩展 `@velaros-ai/capabilities@0.9.0` 包含 Project、Images、Browser、Computer、Office、Skills 等专项单元与资源，以**必需、精确同版 peer**复用基础。产品从 GitHub Release 显式选择安装两份归档；扩展不会再向 registry 请求第二份基础。

实际 Bun 归档消费要求组合根把基础 dependencies 与根 overrides 绑定到同一个固定资产来源，再保留锁文件 integrity。这个来源绑定纳入公开接入合同；未改产品依赖。前一轮基础成功结果保留，扩展的依赖解析失败只复用同一已校验归档重试安装，没有重跑基础或已通过的行为测试。

2026-11-10 修正：以上是 0.9.0 的历史验证记录，该 overrides 接入方式已被正式消费规则取代。0.9.7 使用同 tag 官方基础 URL 的普通必需依赖，消费者声明相同 canonical URL，不携带 overrides/resolutions；见 [普通依赖发行修正](plain-dependency-release-20261110.md)。

发行单元独立登记，不增加空源码包或逐目录拆包。JS、声明、模板与资源分配同时切断；基础→扩展、扩展→基础私有实现、未登记依赖均拒绝。纯声明 utility-types 支持文件可随各自声明复制，不复制运行内核。模板只按显式资产登记辨认，不全局豁免虚拟 import。safe-package-pack 的目录、超时和进程组回收保持。

Desktop/Workbench 明确选择基础与扩展；Server 仅基础并注入自己的运维/终端端口。Termel/Labs 按实际能力迁移。产品源码、依赖和远端服务均未修改；旧隔离补丁未重放。精确签名与删除清单见 [ADR 0028](../decisions/0028-runtime-foundation-and-capability-distributions.md)。

## 本轮证据

- format 已执行；用户 `packages/context/test/storage-index.test.mjs` 排除格式化并保留原字节，不暂存。
- 本次源码基础依赖拓扑和最终 Velaros 定向构建通过；未复用交接前 dist 作为行为证据。
- 改动文件 ESLint 通过；module ownership 对全部受影响 Velaros 单元通过，其余未改模块在首次整仓静态门已通过。
- 最小行为验证 3/3：INV-30、INV-39 durable、INV-47 full runtime close。发行边界小测 5/5；未运行全量回归、压力或长时评测。
- README 33 段通过。更多迁移后的测试保留在仓库，本轮未扩大执行矩阵。
- 基础实际归档与隔离消费者已通过 JS、skipLibCheck:false、真实进程和持久恢复。确定性 ModelDriver 发起 3 次模型调用，未请求真实供应商 API。

基础归档：`C:/Users/29062/AppData/Local/Temp/velaros-distribution-check-lZ67pV/velaros.tgz`；SHA256 `ba4c31c49582380d84f63b884c44bc2fbd4897bb45bbda6a33ad68f1aa789045`。压缩 2,208,075 bytes、安装包目录 10,014,246 bytes；隔离消费者 node_modules 139,570,886 bytes，**包含声明检查所需的 @types/node，不能当作纯生产依赖体积**。完整清单和原始阶段证据在同目录 receipt.json。

扩展归档：同目录 `capabilities-1794199406714.tgz`，SHA256 `7455cef23df7acab4db1c3e74d7bb036a480a5012000283c8a88e1add49af355`。压缩 7,148,173 bytes、扩展安装包目录 34,343,003 bytes；安装两包后的消费者目录 353,229,350 bytes，同样包含声明检查的支持依赖。显式项目事务、共享基础目录身份与扩展的 skipLibCheck:false 消费均通过。旧失败尝试归档留在 receipt 中，交接只选 stage=complete 的这两份身份。

已校验字节复制到仓库受管候选目录：`D:/Projects/VelarOS-Platform/.velaros-workspace/candidates/platform-0.9.0-ba4c31c4-7455cef2/`。该目录的 `candidate.json` 是小交接 receipt，列出两个 tgz 的绝对路径、SHA256、SHA512 integrity、0.9.0 身份、dirty 候选声明及 638 个源码输入的指纹。候选指纹为 `9755d000d987ace0a631467d8765993f23ff0d027eab65676b23c6104c629ea4`，逐输入清单随候选保存。

交接前完整包压缩基线 9,351,900 bytes，仅供体积比较；其 ignored dist 有来源偏差且旧检查失败，不能作为本次正确性证据。当前尚不制定 Linux 安装体积、内存或启动预算。

## 仍需环境与交接

本机是 Windows，没有可用 WSL 发行版或 Docker。只读手动工作流 `.github/workflows/foundation-consumer.yml` 已准备好，在干净 Ubuntu/Node 24.22.0 运行同一最小归档消费者；尚未推送、触发或得到 Linux 结果。完整供应商验证另需隔离 Linux 目标及测试模型配置；不会在用户生产 Cloud 执行。

实际归档来自本批提交前的工作树，receipt 如实记录基础 HEAD 和 dirty 状态；归档以 SHA256 固定，不冒充正式清洁发布。产品只接本轮最终归档身份，正式发布仍走既有 tag/源码核验流程。
