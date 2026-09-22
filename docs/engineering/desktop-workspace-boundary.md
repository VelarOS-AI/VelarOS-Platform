# Desktop 工作区边界沉淀差量

日期：2026-09-22。本轮将主会话的工作区身份与命令目录边界统一到 Platform；基于当前工作树增量修改。

## 对外契约

- Runtime `contract/requires.ts` 的 `VelarosRuntimeOptions` 增加可选 `project?: boolean`。false 保留 workspace 身份，关闭默认 Project 能力及项目证据源。显式注入模块的授权范围仍由宿主负责。
- `VelarosRuntime.openSession` 签名保持，打开前通过 ContextStorage 原子提交绑定；同一会话重新指定不同真实工作区（包括有无 workspace 的变化）抛出 `WORKSPACE_BINDING_MISMATCH`，必须新建会话。符号链接别名解析到同一根时允许重开。
- Project `contract/requires.ts` 增加并公开 `ProjectShellHostPort`，包含项目根与 ShellHostPort；`ProjectCapabilityPortsApi.shell` 接收该较小接口。原 ProjectHostPort 继承该接口，原有调用兼容；sandbox/images 的依赖保持。
- 模型操作、schema、工具定义保持原有合同。

## 持久性与迁移

RuntimeWorkspaceBinding 在 kernel 激活前写入 `runtime:workspace` 审计记录。对象与会话记录复用既有 ContextStorage，CAS 冲突重新读取并核对获胜绑定；同一存储中的不同会话仍可分别绑定。无额外数据库或隐式存储后端。

当 dataDir 存在旧 Desktop `workspace.json` 时，先核对其内容再建立持久记录。旧文件读取失败、格式损坏或范围不符均拒绝打开；迁入后即使旧文件缺失仍由会话记录约束。既有无绑定的会话按首次打开的 workspace 建立身份。绑定新增审计记录，因此 Desktop 首次导入旧转录改为检查用户记录，不再依赖空游标。

绑定约束会话的 workspace 配置。进程文件系统隔离仍由既有 Shell confinement 配置执行；命令工作目录校验不等于对任意命令正文的文件访问隔离。

## Desktop 消费

PlatformSessionStore 仅持有产品会话目录映射、文件系统路径解析和删除。命令端口直接使用 Platform `projectCapabilityPorts.shell`，复用真实路径边界与项目资源门。纯聊天仍传 workspace，同时关闭项目及命令能力；切回项目模式沿用同一绑定。

本轮验证中发现 Context `utils/progress.ts` 已使用 ContextTuning 却缺少导入，补齐这一处依赖以恢复真实执行后的差量计算。

## 验收差量

- 新增 Runtime INV-39：重开、别名、链接改指向、能力切换、并发绑定、旧文件迁移/损坏、无工作区会话固定身份。
- Desktop 新增实际纯聊天切回项目后读取文件，以及关闭进程沙箱时仍拒绝父目录与符号链接外部 cwd 的集成验证。
- 既有项目路径边界验收保持；旧转录测试的注入 inspect fixture 增加真实 protected 字段。

## 验证结果

- Runtime 12 项通过，包含连续 80 次推进、持久重开与 4 项新增绑定用例；Project 23 项验收通过。
- Desktop 真实集成 14 项通过，Electron Node 环境复测 14 项通过；21 个受影响类型分区通过。
- Platform 7 包拓扑构建、Desktop 生产构建与 Electron 入口产物核验通过。
- 两仓 module ownership 与 git diff --check 通过。
- Desktop 架构差量检查剩余 document-renderer README 的 6 项既有错误；该文件本轮无改动。
