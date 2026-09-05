# 显式本地包发布

GitHub Actions 无法调度时，Platform 提供显式本地维护入口。它使用同一份发布拓扑、完整质量门和安全打包发布器。CI 的 `release:verify` 与 tag 工作流继续按 GitHub 提供的身份运行；本地模式使用实际 Git 身份，不设置或改写 `GITHUB_*`。

## 准备发布源

将本次源码、包版本、锁文件和发布流程一起提交。工作树必须干净，包括未跟踪文件。发布 tag 必须已经存在于 `package.repository` 指定的官方 GitHub 仓库，且满足：

- `origin` 是该仓库的 HTTPS 或 Git SSH 地址。
- 本地 `tag^{commit}` 等于 `HEAD`。
- `git ls-remote origin` 返回的同名 tag 对象及其 peeled commit，与本地 tag 和 `HEAD` 精确一致。
- tag 符合现有整列 `v<根版本>` 或单包 `<包名>@<包版本>` 契约。

本地模式使用 `packageManager` 声明的精确 Bun 版本。发布凭据由进程环境中的 `NODE_AUTH_TOKEN` 提供，权限应限于目标 GitHub Packages 注册表；不要把凭据写进仓库或日志。

## 执行

在经过核验的 tag checkout 中运行：

```sh
bun run release:local v0.6.14 --only agent,browser,computer,project,development,memory,model,office,system
```

`--only` 沿用现有发布拓扑的规则：只收窄整列 tag 的包集合，全量声明、版本与锁文件、平台代和依赖拓扑仍需通过验证。单包 tag 已确定范围，不能再加 `--only`。缺失、重复或未知参数直接失败。`--local-tag` 是真实发布模式；本地模拟仍使用 `bun run release:dry-run`。

发布器依次执行身份和凭据检查、`bun install --frozen-lockfile`、完整 `bun run check`、新构建和逐包发布。冻结安装后、质量门后、新构建后以及每个包真正发布前都会重新核验 `HEAD`、本地及远端 tag、工作树。任一步失败立即停止，真实发布不接受 `--skip-build`。

每个包通过 `safePackPackage` 在独占临时目录中打包。发布器验证 tarball 的包名、版本、可安装依赖和构建产物，记录源码 SHA、tag、文件大小及 SHA256；发布前再次检查字节摘要，`bun publish` 接收的就是该 tarball 路径。现有安全入口的超时、进程组回收和路径保护保持生效。

该入口只发布选定的包。产品依赖安装与验证由各消费者维护；它不运行跨仓更新、创建 PR 或修改 Actions 账单。已经发布的版本不会被覆盖；发布器沿用 `--tolerate-republish`，因此恢复一次中途失败的发布后，应从注册表核实目标版本及实际包内容，再进行消费者冻结安装。

## 回归检查

`bun run check:release-source` 执行不访问注册表的构造测试，覆盖参数、仓库地址、轻量/annotated tag、远端不一致、检查期间身份变化，以及完整质量门的执行顺序和失败传播。该命令已接入 `check:gates`；它本身不会安装、构建或发布任何包。
