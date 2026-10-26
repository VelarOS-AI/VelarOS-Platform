# VelarOS Platform

[English](README.md)

VelarOS 的品牌终局是属于个人的 AI 操作系统，以及围绕 VelarOS Kernel 生长的完整 AI 应用生态。VelarOS Platform 是这套生态的共同根基，为不同 AI 应用提供可复用的执行、能力、记忆、权限、上下文、状态、模型与 Agent API。

VelarOS Desktop 是首款真实产品、桌面 Shell 和 reference integration。它负责验证 Platform，但不反向定义 VelarOS 的最终边界。

## 项目状态

本仓库是 VelarOS Platform 的公开源码仓库。新增内容全部按公开源码标准维护：Platform 不得依赖私有产品假设、本机路径、凭据、仓外隐藏裁决或未记录的构建条件。

第一方源码采用 [Apache License 2.0](LICENSE)。

## 仓库结构

VelarOS Platform 包含 9 个 package workspace，各自独立发布。公开包各自遵循 semver，
并通过统一的 `velaros.platform` 代号声明跨包兼容性。

| 领域 | 包 |
| --- | --- |
| Kernel | `@velaros-ai/kernel` |
| Agent 运行时 | `@velaros-ai/agent`（Act 循环、运行生命周期与子任务调度） |
| 共享原语 | `@velaros-ai/core`（基础原语，外加 `platform`、`text-files`、`path-rules` 三个单元） |
| 能力公共件 | `@velaros-ai/script`、`@velaros-ai/context`、`@velaros-ai/velaros` |
| 模型供应方 | `@velaros-ai/model` |
| 评测 | `@velaros-ai/agent-lab` |
| 可安装 JS/TS Skill | `@velaros-ai/skill-jsts` |

根 `package.json` 中的包清单是机械核对的身份单源。公开 API 以包 manifest 和包 README 为准；架构与协议裁决归本仓 `docs/` 所有。

## 环境要求

- [Bun](https://bun.sh/) 1.3.13
- 完整工作区（含 JS/TS Skill）要求 Node.js 22.15 或更新版本；当前 Windows 核验使用 Node.js 24.22.0。默认 SQLite 适配器单独要求 Node.js 22.13 或更新版本。
- 单包消费者还需遵守各包 engines 及宿主依赖要求

## 开发

```bash
bun install --frozen-lockfile
bun run build
bun run typecheck
bun run test
bun run check
```

`bun run check` 是合入总门：构建全部包、类型检查、lint、测试、架构边界和公开发布不变量必须同时通过。

架构、包边界与开发者指南从[文档索引](docs/readme.md)开始阅读。
独立安装的 VelarOS Termel 产品负责自己的 Host 组合与原生发布生命周期；共享远程节点传输归 Kernel。

## 从这里开始

- [Runtime 接入](packages/velaros/act/runtime/README.md)：创建运行时、注入宿主端口、提交输入并消费事件。
- [Script](packages/script/README.md)：使用标准 Node.js 执行程序，通过已授权的 Kernel 能力桥调用宿主。
- [Skills](packages/velaros/skills/README.md)：安装包，按需加载说明、依赖与能力。
- [运行主链](docs/architecture/platform-runtime.md)和[生成包目录](docs/generated/package-catalog.json)：当前执行架构与公开入口。

本仓库按 Apache-2.0 公开。独立产品仓库不会因为依赖 Platform 而自动适用本仓许可证。根 package.json 保持 private，防止误发布整个 monorepo 根包。

正式包归档与校验清单通过公开 GitHub Releases 分发。旧 GitHub Packages 的 @velaros-ai 注册表仍需 .npmrc 引用的 NODE_AUTH_TOKEN。源码开发使用 workspace 依赖与已提交锁文件。模型凭据、存储、进程执行和授权由产品宿主注入，不导入私有产品源码。

## 验证边界

[测试与平台支持](docs/engineering/testing.md)说明测试运行器、Windows 限制与专项检查。Bun 用于仓库工具和 TypeScript 测试，应用中的程序执行引擎是 Node.js。Bun 下的失败需要区分宿主差异，类型检查通过也不等于真实运行通过。

依赖安全门先核验已安装补丁字节，再应用有文档依据的审计例外，见[依赖安全策略](docs/engineering/dependency-security.md)。CI 与正式包发布在 GitHub Actions 使用固定工具链执行完整质量门；GitHub Releases 提供可公开下载的归档及源码、哈希清单，见[发布流程](docs/engineering/local-package-release.md)。

## 贡献与安全

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。社区协作遵循 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，项目治理见 [GOVERNANCE.md](GOVERNANCE.md)。

安全漏洞不要提交到公开 Issue，请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

Copyright 2026 VelarOS-AI contributors.

本项目采用 [Apache License 2.0](LICENSE)。

共享 UI 与组件展示站由 `VelarOS-UI` 仓库维护；Document Renderer 包与独立产品由 `VelarOS-Desktop` 仓库维护。

语言服务由 `@velaros-ai/velaros/project` 提供。`velaros` CLI 由 VelarOS-Termel 维护，UI 与 component-library 由 VelarOS-UI 维护，document-renderer 归 VelarOS-Desktop。
