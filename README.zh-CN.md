# VelarOS Platform

[English](README.md)

VelarOS 的品牌终局是属于个人的 AI 操作系统，以及围绕 VelarOS Kernel 生长的完整 AI 应用生态。VelarOS Platform 是这套生态的共同根基，为不同 AI 应用提供可复用的执行、能力、记忆、权限、上下文、状态、模型与 Agent API。

VelarOS Desktop 是首款真实产品、桌面 Shell 和 reference integration。它负责验证 Platform，但不反向定义 VelarOS 的最终边界。

## 项目状态

本仓库是 VelarOS Platform 的公开源码仓库。新增内容全部按公开源码标准维护：Platform 不得依赖私有产品假设、本机路径、凭据、仓外隐藏裁决或未记录的构建条件。

第一方源码采用 [Apache License 2.0](LICENSE)。第三方软件继续遵循其原许可证，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 仓库结构

VelarOS Platform 包含 17 个 package workspace，其中 16 个独立发布。公开包各自遵循 semver，
并通过统一的 `velaros.platform` 代号声明跨包兼容性。

| 领域 | 包 |
| --- | --- |
| Kernel | `@velaros-ai/kernel` |
| Agent 运行时 | `@velaros-ai/agent` |
| 共享原语 | `@velaros-ai/core` |
| 模型供应方 | `@velaros-ai/model` |
| 能力 | `@velaros-ai/browser`、`@velaros-ai/cli`、`@velaros-ai/computer`、`@velaros-ai/development`、`@velaros-ai/office`、`@velaros-ai/project`、`@velaros-ai/system` |
| 记忆 | `@velaros-ai/memory` |
| UI | `@velaros-ai/ui` |
| HTML 工件 | `@velaros-ai/html-artifacts` |
| Surface 协议 | `@velaros-ai/surface-protocol` |
| 评测 | `@velaros-ai/agent-lab` |

根 `package.json` 中的包清单是机械核对的身份单源。公开 API 以包 manifest 和包 README 为准；架构与协议裁决归本仓 `docs/` 所有。

## 环境要求

- [Bun](https://bun.sh/) 1.3.13
- Node.js 20 或更高版本
- `better-sqlite3` 与 Electron rebuild 所需的本机编译工具

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
独立安装的 VelarOS Termel 产品负责自己的 Host 组合、远程节点传输与原生发布生命周期。

## 贡献与安全

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。社区协作遵循 [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)，项目治理见 [GOVERNANCE.md](GOVERNANCE.md)。

安全漏洞不要提交到公开 Issue，请按 [SECURITY.md](SECURITY.md) 报告。

## 许可证

Copyright 2026 VelarOS-AI contributors.

本项目采用 [Apache License 2.0](LICENSE)。
