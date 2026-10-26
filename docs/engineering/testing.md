# 测试与平台支持

Platform 的生产程序在宿主提供的 Node.js 中执行；Bun 用于包管理、仓库命令和部分 TypeScript 测试。两者的 HTTP、进程与文件系统实现不相同，不能用其中一个的通过结果替代另一个。

## 环境与命令

- 发布必须使用根 package.json 固定的 Bun 版本；日常验证报告同时记录实际 Bun 与 Node 版本。
- Linux CI 与发布 runner 安装 bubblewrap 和 ripgrep。项目搜索的真实后端合同必须调用实际 rg，不能把缺失依赖后的 adapter 回退当成 ripgrep 验收。
- 完整工作区包含要求 Node.js 22.15 的 JS/TS Skill。SQLite 适配器的单独最低要求为 22.13；本次 Windows 核验使用 Node.js 24.22.0 与 Bun 1.4.3，不代表固定发布工具链已全量验收。
- 先执行 `bun install --frozen-lockfile`。根开发依赖提供浏览器合同检查所用的 Vite；Velaros 开发依赖提供 React 和 Electron，产品消费者按公开 peer 合同提供自己的宿主。
- `bun run format` 统一源码格式；`bun run check` 顺序运行构建、类型检查、lint、格式、测试、套件与门禁。类型检查只通过 `bun run typecheck` 进入既有逐包流程。
- `bun run test` 是全量测试入口。它按包运行各自声明的 Node/Bun 测试命令；检查第一处失败后仍需区分其他包的独立结果。
- `bun run check:dependency-security` 核验本地补丁及依赖漏洞；`check:agent-browser` 验证浏览器合同不带 Node 内建依赖；`check:readme-examples` 检查模块 README 示例；`check:public-readiness` 检查公开元数据和链接；`check:module-ownership` 检查所有权与合同。

完整检查不会因为源码已经公开而放宽。发布包仍要求通过现有发布门；本机的部分检查通过不能作为发布凭据。

## Windows 验证边界

### Bun HTTP 命名管道

Script 的能力桥在 Windows 使用每次执行独占的命名管道，在 POSIX 使用 Unix socket。Bun 1.4.3 的 `node:http.Server.listen(pipe)` 返回 `ENOENT`，但 `node:net` 可以监听同一管道。运行器在 Windows + Bun 且 HTTP server 提供 connection 处理器时，使用 net 接受连接并交给原来的 HTTP server 解析、鉴权和分发；Node 宿主继续走原来的 HTTP 监听路径。固定版 Bun 1.3.13 没有这个处理器，会立即返回 `UNAVAILABLE`，不启动宿主执行器，也不挂起等待。已验证的兼容版本为 Bun 1.4.3；这不代表 Bun 1.3.13 的 Windows 完整发布门通过。连接上限保持 64，执行结束会销毁所有接入连接并关闭监听器。

`packages/script/test/subprocess.test.ts` 的传输回归在 Windows + Bun 1.4.3 实跑，覆盖错误凭据、未授权操作和路径、非法 JSON、16 路并发、超时取消、未完成调用、闲置连接与监听器清理。Skills 的真实 Node 集成测试也验证 ESM/CJS、预加载和 Kernel 能力调用。

管道兼容不等于默认进程宿主支持 Windows。`executeNativeNode` / `nodeSubprocessCodeRunner` 依赖 POSIX 进程组，仍在 Windows 拒绝执行；相关集成测试显式按平台跳过，另有回归确认拒绝返回 `UNAVAILABLE`。缺少 HTTP 连接处理器的旧版 Bun 另测能力桥拒绝且不启动宿主执行器；传输用例在这种运行时明确跳过。Windows 产品必须通过 `NodeCodeRunnerOptions` 注入拥有进程树回收与权限约束的实际宿主。跳过项不是 Windows 验收通过，POSIX 执行语义仍需在 POSIX 环境运行。

### 文件权限与路径

Windows 的 Node 文件接口不实现 POSIX 的完整 uid/gid/mode/umask 语义。专门验证 0600、0700、可执行位或 umask 的用例仅在 POSIX 运行；编码、字节、符号链接和事务测试在所有平台继续运行，并核对写入前后操作系统实际报告的 mode 相同。非法 mode 的拒绝仍在所有平台测试。Windows ACL 隔离需要产品宿主单独验证。

Windows 不允许用原子 rename 覆盖只读文件。外部程序把事务目标设为只读后，rollback 会失败并保留当下字节与只读状态；调用方明确恢复写权限后可重试。专门的 Windows 回归验证这一行为。库不会为了完成回滚偷偷解除外部设置的只读保护。POSIX 的“回滚后保留外部 chmod”承诺继续按原用例验证。

动态 ESM 导入必须使用 `pathToFileURL(path).href` 或原始 URL 的 `href`，不能把 Windows 绝对路径当模块 URL，也不能把 URL 的 `pathname` 当本机路径。当前安全探针、Node 正则回归与跨进程记忆回归使用这一规则。

文件系统绝对路径的断言使用本平台分隔符；公开的相对路径合同仍使用 `/`。模型模板生成器将 CRLF 统一成 LF，验收比较时必须使用相同规则，继续逐字校验模板内容。

### SQLite 清理

Node 测试的 `t.after` 按登记顺序执行。创建目录时先登记删除、随后才登记关闭连接，会在 Windows 遇到 `EBUSY`。fixture 必须拥有它创建的连接，在同一个清理钩子中先关闭全部连接，再删除独占临时目录；重开和重复 close 的幂等性仍由原验收覆盖。

## 前一轮验证记录（修复前）

2026-10-26 的维护修复覆盖：缺失的 Vite/React 开发依赖、Electron 安全版本、同主版本内的漏洞依赖升级、SQLite fixture 生命周期、Windows ESM 导入、路径分隔符与模板换行断言。未修改生产能力桥、公开操作合同、权限策略或包版本。

依赖安全专项、README 示例、公开链接和模块所有权分别验证；完整测试中的平台限制和未解决失败按实际结果报告，不增加 audit ignore、不删除失败用例，也不把历史通过记录当作当前结果。历史评测和交接快照保留各自的日期与源码身份，当前用法以持续维护的架构文档、包合同和 README 为准。

本机 Electron 42.11.16 安装包已核对官方 SHA-256，并通过二进制 `--version` 核验。隔离运行固定版 Bun 1.3.13 后，宿主合同消费门在安装 tarball 依赖时遇到缓存目录 `EPERM`，因此 `check:gates` 仍未通过。日常 Bun 1.4.3 的结果不能代替这一发布门；不得改动版本门或略过安装错误来宣称发布检查成功。

前一轮 `bun run check` 的构建、逐包类型检查、lint 和格式检查通过；测试阶段结果如下。跳过项均为既有条件，未新增跳过。

| 包 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Agent | 107 | 0 | 0 |
| Agent Lab | 54 | 0 | 0 |
| Context（Node 与 Bun 合计） | 141 | 0 | 4 |
| Core | 161 | 10 | 1 |
| Kernel | 183 | 1 | 5 |
| Model | 236 | 0 | 0 |
| Script | 106 | 65 | 0 |
| Velaros（首段 Bun 测试） | 1172 | 52 | 55 |

Skill JS/TS 没有独立 test 命令。Core 的权限断言、Script 的 Bun 命名管道、Velaros 的同类问题及部分 Git、shell、浏览器启动夹具仍未解决；Kernel 另有文件权限相关的未处理错误。剩余失败不能全部解释为测试误报，也不表示对应产品宿主已验证。Velaros 的后续 Node/Act 测试、根 test:act-eval 和 test:suites 被前序失败阻断，本轮完整命令没有执行到这些阶段。

独立通过的专项包括依赖安全（512 个包、1 项已有审计例外）、依赖许可证、浏览器合同、33 个 README 示例、公开准备、锁文件一致性、包目录和模块所有权。发布检查仍不满足要求；后续应在固定工具链和适合的平台继续处理保留失败。

## 本轮差量（2026-10-26）

- Git 命令存在性检查复用 PATH/PATHEXT 解析，Windows 环境键大小写不再影响判断；`git check-ignore` 的正常退出码 1 不再改写成“命令缺失”。
- Shell 枚举读取原始宿主环境；Windows 共享环境缓存与已自检 shell 的派生环境分开，默认选择不会伪装成用户显式锁定。检查与刷新保留所有候选，用户显式选择仍然保留。
- Kernel 权限验收即使断言失败也在 finally 中关闭 daemon 与 service，防止 FileHandle 被 GC 代为关闭。
- 路径和下载目录断言使用本机路径；短引用测试分别使用经过核对的 Windows/POSIX SHA256 前缀碰撞；沙箱根目录夹具选用临时基目录所在盘的实际根。
- Core INV-3 与 Kernel INV-15 明确 POSIX 权限位承诺的适用平台；事务用例继续验证实际权限、精确字节和重试。Script 的公开 API、授权模型、默认进程执行边界不变，能力桥增加 Bun/Windows 兼容监听。

本轮完整验证结果见下方；前一轮失败数仅用于对照，不代表当前状态。

### 本轮 Windows 测试记录

本轮 `bun run test`：2,201 项通过、158 项跳过、3 项失败。失败均为 `project-write-risk.test.ts` 的 5 秒超时，发生时并行 lint 已出现内存不足；停止其他重检查后单独重跑该文件，16 项全部通过，未改测试超时。原来报告的 128 项失败没有在这一轮重现；其中平台不适用项改为显式跳过，不能算作在 Windows 执行通过。

| 包 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| Agent | 107 | 0 | 0 |
| Agent Lab | 54 | 0 | 0 |
| Context（Node 与 Bun 合计） | 141 | 0 | 4 |
| Core | 170 | 0 | 4 |
| Kernel | 183 | 0 | 6 |
| Model | 236 | 0 | 0 |
| Script | 111 | 0 | 63 |
| Velaros（首段 Bun 测试） | 1199 | 3 | 81 |

随后补充的旧版 Bun 处理器检测回归：Bun 1.4.3 下传输与默认运行器拒绝用例 3 项通过、旧版拒绝分支 1 项跳过；固定 Bun 1.3.13 下拒绝用例 2 项通过、传输用例 2 项跳过。Shell 共享环境回归 8 项通过、1 项既有 POSIX 捕获测试跳过。上述定向结果不计入表中的那次完整命令。

由于那次全量命令仍有超时失败，Velaros 后续 Node/Act、根 test:act-eval 和 test:suites 未执行。完整发布门没有全部通过；固定 Bun 的 Windows HTTP 处理器限制和上一轮宿主消费门的安装错误仍需在适合的工具链上解决，不把定向重跑或平台跳过等同于发布认证。

最终串行复核：`bun run typecheck`、`bun run lint`、`bun run check:format` 均通过；模块所有权与 33 个 README 示例检查通过。`bun run format` 已执行，暂存差量检查无空白错误。本轮还修正了同期 Runtime 提交的 import 排序与方法简写两处 lint 问题，未改变其行为。

## GitHub Linux 发布检查（2026-10-26）

正式 CI 和发布已迁到 GitHub Actions，使用固定 Bun、Node 24.22.0、bubblewrap 与 ripgrep。首次运行缺少 rg 的六项真实搜索后端失败已通过补齐环境依赖处理，未跳过搜索验收。

后续完整运行的 Runtime Node 用例为 1,192 通过、5 失败、8 跳过。修订五处夹具与断言：追踪预算纳入已经展示的子任务正文并保持 64 字符总额；自动封卷模型支持当前 JSON 叙事合同，同时继续核对持久化与每卷唯一计费；长期记忆检查当前声明发现键；80 轮状态用例按原有 48,000 字符配置检查上限、封卷与最终计数，原 20,000 字符断言只是旧夹具尺寸而非配置合同；超时回收用例保留真实超时/取消和输出断言，为 Node 冷启动提供 3 秒测试期限，不改变产品默认期限。这些调整不修改模型提示词，不移除完整质量门；是否可以发布以最新 Actions 全量结果为准。

CI 的手动 runtime_diagnostics 入口只运行指定运行时回归，作诊断用，不是发布凭据。推送、PR 和默认手动运行仍执行完整 check，发布器也始终独立执行完整 check。
