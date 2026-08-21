# `.velarmod` v1 包格式与接入流程

本文件定义 VelarOS Mod 的标准交付单元、开发闭环和宿主安全边界。源码可以在任意独立项目维护，
但进入 Desktop、市场或官方发行物时，**每个 Mod 必须恰好对应一个 `.velarmod` 文件**。

## 1. 交付单元

`.velarmod` 是使用 VelarOS 约束的 ZIP 容器，不是“任意 ZIP 换扩展名”。v1 规则：

- 扩展名固定为 `.velarmod`，MIME 建议为 `application/vnd.velaros.mod+zip`；
- 根目录必须有且只能有一份 `velaros.mod.json`；
- manifest 的 `module.id` 与 `agent.id`（若存在）必须一致；
- 路径只用 `/`，不得是绝对路径、包含 `..`、反斜杠、控制字符或符号链接；
- 最多 512 个文件、8 层目录、240 字符路径；宿主 v1 接受的压缩包不超过 32 MiB，解压后不超过
  128 MiB；
- 不接受加密 ZIP；异常压缩比、CRC 错误、大小写/Unicode 规范化后重名均拒绝；
- 确定性构建必须固定条目顺序、时间戳、压缩算法与级别。同一源码和构建器应得到同一字节产物。

可选文件：

| 文件                    | 用途                                                                      |
| ----------------------- | ------------------------------------------------------------------------- |
| `velaros.mod.sig.json`  | 市场/官方 Ed25519 签名 sidecar；覆盖 mod id、版本与除自身外的完整产物摘要 |
| `velaros.internal.json` | 官方构建生成的静态绑定说明；外部导入不能凭此获得内置信任                  |
| 其余资源                | Markdown、声明式 UI、静态资产或受信任档位允许的运行时入口                 |

## 2. Manifest 单一权限事实

真正执法的权限清单是 `velaros.mod.json` 的 `module.permissions`。`agent.permissions` 只是领域元数据；
若两者同时出现，应保持相同。宿主发现不一致时必须提示，并始终以 `module.permissions` 为准。

外部 Mod 可以申请高级能力，不设“社区只能读文件”一类产品上限；但每一项必须同时满足：

1. 权限位已进入宿主公开目录，拥有稳定说明和风险级；
2. Mod 在 `module.permissions` 显式声明；
3. 导入时在权限清单中展示，由用户逐项勾选或一键批准；
4. 运行时调用仍经过 capability broker，并按 `(modId, permission)` 审计；
5. 用户之后可逐项撤销。未知权限默认拒绝，不能弹一个通用“全部放行”。

Desktop v1 目录：

| 风险   | 权限位                                                                                              |
| ------ | --------------------------------------------------------------------------------------------------- |
| 常规   | `fs:read`, `browser:control`                                                                        |
| 敏感   | `network`, `memory:read`, `system:open`, `screen:capture`                                           |
| 高风险 | `fs:write`, `memory:write`, `input:control`, `process:exec`, `agent:execute`, `process:exec:unsafe` |

风险级决定展示强度，不替代用户决定，也不表示宿主绕过操作系统自身权限、工作区范围或执行确认。

Desktop v1 的声明式 `invoke-capability` 公开面也是闭集，但覆盖当前所有已稳定的可调用操作：

| Capability        | Operations                            |
| ----------------- | ------------------------------------- |
| `velaros.model`   | `supports_provider`                   |
| `velaros.browser` | `close_session`, `close_all_sessions` |
| `velaros.agent`   | `health`, `execute`                   |

“能力已在 Kernel 内注册”不等于“自动成为外部 Mod API”。新增操作必须显式进入版本化公开目录，并补齐
输入约束、权限与审计测试；这避免未来内部模块一注册就被旧 Mod 意外调用。目录应持续扩展，但不能隐式扩展。

## 3. 信任不由 Mod 自报

manifest 中的 `agent.trust` 是构建意图，不是最终信任事实：

- `bundled-official` 只由 VelarOS 官方打包流程产生，并通过应用自身签名/完整性链交付；
- `marketplace-signed` 必须通过宿主内置可信公钥验签；签名缺失、密钥未知、摘要或身份不符均阻断；
- 用户拖拽的未签名包由宿主盖章为 `local-dev` / “用户导入”，即使 manifest 自称官方也不得升级；
- 外部导入包永远不能获得 `bundled-official`。内部标记文件、文件名或安装路径都不是信任证据。

## 4. Desktop 导入状态机

```text
拖拽/选择 .velarmod
  → 只读预检（格式、路径、体积、CRC、manifest、签名、权限目录）
  → 展示身份、来源、风险与完整权限清单
  → 用户确认信任，并逐项勾选 / 全部批准 / 全部取消
  → 主进程复扫同一路径并核对整包摘要
  → 安全解压到临时目录
  → 版本化安装 + 授权账本原子替换
  → 激活；失败可诊断、可回滚
```

扫描票据必须短期有效并绑定整包摘要。界面不能直接发放权限：安装请求只提交用户选择，主进程必须
验证它是扫描时声明权限的子集。包在确认期间发生变化时整次作废，重新扫描。

## 5. 内置与外部使用同一包模型

源码所有权与产品露面是两条独立轴：

- 每个内部 Mod 仍在自己的 owner 项目/源码目录维护；不得把实现复制进一个中央 `mods/` 大仓；
- Desktop 打包阶段读取各 owner 导出的 Mod 定义，构建确定性 `.velarmod`，运行时代码可通过
  `static-build-graph` 静态绑定进应用；
- 内置身份、版本、权限和贡献仍来自同一 manifest，不另写一份产品清单；
- “是否显示在 Mods 页”由宿主目录决定，Mod 不得自称 internal 把自己隐藏；
- Browser 工作区、System 工作区、Project 工作区、Agent 内置轴、网页 Agent 桥与外部 Agent
  引擎属于隐藏的内置 Mod；Game、Pet 等可作为用户可见的官方可选 Mod；
- Remote Host 是独立宿主产品，不因为共享 Kernel 就伪装成 Mod。

`velaros.agent-engines` 只把 Claude Code/Codex 的身份、权限和生命周期纳入 Mod 标准。driver、目录
`executionBinding` 路由权、单驱动互斥、WAL-first、审批恢复与 fail-closed 仍由引擎 owner 持有，
不能为了“像 Mod”再造一套执行状态机。

## 6. 标准开发命令

在 VelarOS Platform 仓库：

```bash
bun run mod validate ./my-mod
bun run mod pack ./my-mod ./dist/my-mod-1.0.0.velarmod
bun run mod inspect ./dist/my-mod-1.0.0.velarmod
```

官方宿主构建才可加 `--bundled`。常规开发者不得用它制作外部分发包。

推荐流水线：`validate source → test bindings → pack → validate archive → inspect permissions → sign/publish`。
版本发布后不得用同版本替换不同内容；升级内容必须升级 semver，签名绑定 id、版本和产物摘要。
