# ADR 0028 — 显式 Runtime、Node 资源所有权与能力发行

日期：2026-11-09。状态：实施中；下述切换面为本批目标，验证记录另列，不能视为已通过 Linux 验收。

## 决策与 P0 合同

核心只持有 Agent、Session、执行与上下文事实、交互、授权端口和生命周期。People、Team、项目/浏览器 workspace、目录布局、选择和切换属于产品。没有统一 Workspace、ProductKind 或以改名延续的隐式产品预设。

基础安装身份 `@velaros-ai/velaros@0.9.0`；可选能力安装身份 `@velaros-ai/capabilities@0.9.0`；平台代为 `0.7`。基础 Node 最低版本固定为本轮真实构建与发行环境的 `24.22.0`，不继续声明未通过默认 SQLite 入口的 Node 20。扩展通过基础公开入口共享唯一 Kernel/Agent/Context，不内嵌第二份。源码仍按能力单元同仓维护，发行单元由 `scripts/release/platform-distributions.mjs` 登记，不为每个目录创建包。

```ts
// @velaros-ai/velaros
interface RuntimeSessionBinding {
  readonly executionIdentity: string
  readonly authorizationScope: string
}
interface RuntimeResource {
  close(): void | Promise<void>
}
createRuntime(options: VelarosRuntimeOptions): Promise<VelarosRuntime>
// 必需 options.storage: ContextStorage、options.binding: RuntimeSessionBinding；
// 必须且只能提供 options.node: RuntimeNodeOptions 或 options.runner: CodeRunnerApi。
// options.model?: ModelDriver；options.modules?: readonly OperationModuleDefinition[]。
// options.resources?: readonly RuntimeResource[] 成功后移交，初始化失败仍归调用者。

// @velaros-ai/velaros/node
createNodeRuntime(options: NodeRuntimeOptions): Promise<VelarosRuntime>
// 继承显式 Runtime 配置，替换 storage/runner/node/model：
// cwd: string；stateDirectory: string；binding: RuntimeSessionBinding；
// host?: ShellHostPort；localHost?: Omit<LocalShellHostOptions, 'cwd'>；
// storage?: ContextStorage；model?: ModelDriver | RuntimeModelConfiguration；
// execution?: Omit<NodeExecutionEnvironmentOptions, 'cwd' | 'directory' | 'host'>。
// host/localHost 互斥；自行创建 Host 时必须明确 localHost.processConfinement。
// 本入口还提供 createNodeExecutionEnvironment 及其配置和端口类型。
```

`createRuntime` 不创建本机 Host、存储、模型驱动或领域能力。Node 装配器复用真实 `LocalShellHost`、`NodeExecutionEnvironment` 和同一 `createRuntime`。成功后 Runtime 持有 storage；仅 Node 装配器自己创建的 Host 通过 resources 移交。产品注入的 Host 仍由产品持有，运行彻底收束后再释放。close 超时保持后台收束与资源所有权，不能提前销毁进程 owner。

会话恢复原子核对宿主提供的 executionIdentity、authorizationScope 和真实装配的模块 instance/generation。核心不解释路径或产品身份。Node 环境装配器额外绑定真实执行目录、执行用户、Node 可执行文件和明确本机策略；这只约束执行环境，不创建项目。`moduleAccess(sessionId, moduleId)` 可进一步裁剪已挂载能力，发现与派发使用同一检查。产品必须从已授权资源派生其不透明身份，并在产品恢复入口核对产品成员、授权根和资源映射，不能取模型正文或客户端路径作为授权证据。

## 删除及迁移

- 删除 Runtime 的 workspace、project、skills、dataDir；删除 agents/search 布尔预设、memory/packageEnvironment 的 false 别名。省略可选配置表示没有该能力。
- 根入口不再转发 Node 环境工厂、RuntimeModelConfiguration、项目/图像工厂或其配置。Node 配置从 `/node` 导入。
- `createProjectCapabilityModule`、`createProjectCodeModule`、`createProjectImagesModule` 与配置归 `@velaros-ai/capabilities/project`。项目内核、观察与证据源显式建立；图像与语言服务分别显式选择。
- Skills 的租约、会话与模块由产品显式建立。项目语言授权所有者机制保留为 `createSkillProjectCodeQuery(codeIndex, skills)` 的结构端口，不由 Runtime 猜测。
- 旧 `runtime:workspace` 持久绑定及旧产品 root 默认语义不作兼容读取；旧会话应由产品显式迁移到经核验的新执行身份，或建立新会话。核心不静默接纳旧事实。

基础公开单元为根、contracts、renderer、node、execution、memory、act/system、act/search、act/agents，以及 core/kernel/model/agent/context/script 的公开子路径。搜索、子任务、长期记忆、包环境只在显式配置时装配；运行正确性所需上下文维护继续保留。专项扩展为 features、images、sandbox、project、computer、office、browser、web、sessions、skills、act/bridge 及 skill-jsts 资源。旧 `@velaros-ai/velaros/project` 等专项发行入口删除，不加别名。

## 消费者职责与发行

Desktop 显式选择基础与专项扩展，自己拥有 People/Team、成员、目录及产品恢复。Workbench 显式选择 IDE、项目与自身工作区/会话。Server 使用基础 Node 与自己装配的运维端口，终端由同一个真实 Host 注入；不新增 Server Agent 循环。Termel、Labs 同步新入口及能力清单。各产品只消费固定归档身份，不能引用兄弟仓私有源码或添加临时兼容。

发行器分别计算 exports、声明和 JS 闭包、依赖与资源。基础不携带专项 vendor/二进制/resources 或重依赖；扩展以普通必需依赖固定同 tag 的官方基础归档，与宿主同一 canonical URL 共享唯一实例。移除 registry-only base peer，不使用 optional peer、动态 import 或 optionalDependencies 冒充隔离。所有归档继续走 safe-package-pack 的独占临时目录、超时、进程回收与路径检查。

2026-11-10 按用户最新规则更新：正式消费者只在普通 dependencies 中固定基础和能力的 canonical GitHub Release URL，锁文件保留实际 integrity；能力包对基础声明同一个官方 URL 的普通必需依赖。正式发版不写 overrides/resolutions，覆盖此前依赖 override 或 registry-only peer 的建议。纯官方 0.9.6 peer 方案在 Bun 1.4.3 实际转向 registry 并 404，已改发行元数据；同字节 file 宿主与 HTTPS 扩展依赖仍会出现第二基础，因此生产成对来源统一 canonical URL，不通过补丁或覆盖伪装唯一实例。实际发出的两份字节在 prerelease/non-latest 阶段接受普通安装和共享 Runtime 验收，通过后才晋升正式。

## 验证、基线与风险

原始 HEAD 为 `801603b020fa906ef5499372d05f4e6755beef98`。基线安全 pack 留在 `C:/Users/29062/AppData/Local/Temp/velaros-unified-check-czjCt2/velaros-ai-velaros-0.8.0.tgz`，压缩大小 9,351,900 bytes。该次产物来自交接前 ignored dist，不能作为本次源正确性证据。旧隔离消费者检查在 `defaults.length > 10` 失败，当前源码默认包只有四项；这是已记录的基线门禁陈旧，不能写成通过。

每批重新构建、format、module ownership 与相关回归后提交。首个垂直门为实际基础+扩展 tarball、互相独立的 JS 与 skipLibCheck:false 消费者，以及干净 Linux 普通 Node 的模型→实际命令/文件→交互/取消→终态/恢复。Linux 缺口单独报告；本机 Windows 不替代 Linux。先采集压缩/解包、安装闭包、资源与启动基线，再决定预算。

安全影响是停止隐式授予业务能力、固定恢复的执行边界，并明确唯一资源 owner。破坏性切换须同步消费者、代际与固定归档；回退必须整体回退产品和基础身份，不能混用旧配置或共享未迁移存储。
