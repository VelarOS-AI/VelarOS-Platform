# 测试与平台支持

Platform 的生产程序在宿主提供的 Node.js 中执行；Bun 用于包管理、仓库命令和部分 TypeScript 测试。两者的 HTTP、进程与文件系统实现不相同，不能用其中一个的通过结果替代另一个。

## 环境与命令

- 发布必须使用根 package.json 固定的 Bun 版本；日常验证报告同时记录实际 Bun 与 Node 版本。
- 完整工作区包含要求 Node.js 22.15 的 JS/TS Skill。SQLite 适配器的单独最低要求为 22.13；本次 Windows 核验使用 Node.js 24.22.0 与 Bun 1.4.3，不代表固定发布工具链已全量验收。
- 先执行 `bun install --frozen-lockfile`。根开发依赖提供浏览器合同检查所用的 Vite；Velaros 开发依赖提供 React 和 Electron，产品消费者按公开 peer 合同提供自己的宿主。
- `bun run format` 统一源码格式；`bun run check` 顺序运行构建、类型检查、lint、格式、测试、套件与门禁。类型检查只通过 `bun run typecheck` 进入既有逐包流程。
- `bun run test` 是全量测试入口。它按包运行各自声明的 Node/Bun 测试命令；检查第一处失败后仍需区分其他包的独立结果。
- `bun run check:dependency-security` 核验本地补丁及依赖漏洞；`check:agent-browser` 验证浏览器合同不带 Node 内建依赖；`check:readme-examples` 检查模块 README 示例；`check:public-readiness` 检查公开元数据和链接；`check:module-ownership` 检查所有权与合同。

完整检查不会因为源码已经公开而放宽。发布包仍要求通过现有发布门；本机的部分检查通过不能作为发布凭据。

## Windows 验证边界

### Bun HTTP 命名管道

Script 的能力桥在 Windows 使用独占命名管道，在 POSIX 使用 Unix socket。Node.js 24.22.0 可以通过 `node:http` 在 Windows 命名管道监听；Bun 1.4.3 对同一最小程序返回 `ENOENT`。因此由 Bun 托管的 Script 和部分 Velaros 程序验收会在桥启动前失败，尚未执行到被测模型程序。

这不是以公开 TCP 端口替代本地通道的理由。产品 Windows 宿主需在真实 Node/Electron 环境验证；Bun 的管道行为改善后再运行同一套测试。`nodeSubprocessCodeRunner` 的便利宿主仅承诺 POSIX，Windows 的进程执行与权限由宿主端口提供。

### 文件权限与路径

Windows 的 Node 文件接口不实现 POSIX 的完整 uid/gid/mode/umask 语义。硬断言 0600、0700 或可执行位的验收需要 POSIX 环境；Windows 访问控制需要由产品宿主和操作系统 ACL 单独验证。不得为了让测试通过把“权限已正确限制”改成无条件成功。

动态 ESM 导入必须使用 `pathToFileURL(path).href` 或原始 URL 的 `href`，不能把 Windows 绝对路径当模块 URL，也不能把 URL 的 `pathname` 当本机路径。当前安全探针、Node 正则回归与跨进程记忆回归使用这一规则。

文件系统绝对路径的断言使用本平台分隔符；公开的相对路径合同仍使用 `/`。模型模板生成器将 CRLF 统一成 LF，验收比较时必须使用相同规则，继续逐字校验模板内容。

### SQLite 清理

Node 测试的 `t.after` 按登记顺序执行。创建目录时先登记删除、随后才登记关闭连接，会在 Windows 遇到 `EBUSY`。fixture 必须拥有它创建的连接，在同一个清理钩子中先关闭全部连接，再删除独占临时目录；重开和重复 close 的幂等性仍由原验收覆盖。

## 当前验证范围

2026-10-26 的维护修复覆盖：缺失的 Vite/React 开发依赖、Electron 安全版本、同主版本内的漏洞依赖升级、SQLite fixture 生命周期、Windows ESM 导入、路径分隔符与模板换行断言。未修改生产能力桥、公开操作合同、权限策略或包版本。

依赖安全专项、README 示例、公开链接和模块所有权分别验证；完整测试中的平台限制和未解决失败按实际结果报告，不增加 audit ignore、不删除失败用例，也不把历史通过记录当作当前结果。历史评测和交接快照保留各自的日期与源码身份，当前用法以持续维护的架构文档、包合同和 README 为准。

本机 Electron 42.11.16 安装包已核对官方 SHA-256，并通过二进制 `--version` 核验。隔离运行固定版 Bun 1.3.13 后，宿主合同消费门在安装 tarball 依赖时遇到缓存目录 `EPERM`，因此 `check:gates` 仍未通过。日常 Bun 1.4.3 的结果不能代替这一发布门；不得改动版本门或略过安装错误来宣称发布检查成功。

本次 `bun run check` 的构建、逐包类型检查、lint 和格式检查通过；测试阶段结果如下。跳过项均为既有条件，未新增跳过。

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
