# 本机发布与验证

Platform 的包、Document Renderer 原生能力包、质量门和安全检查都只从维护者的本机 checkout 执行。`.github/workflows/ci.yml`、`codeql.yml`、`release-packages.yml` 与 `release-document-renderer.yml` 仅是零权限、静态跳过的策略哨兵，不承载构建、凭据或发布，也不产生 GitHub Actions 用量。

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
bun run release:verify v0.6.26
bun run release:local v0.6.26 --only agent,agent-lab,memory,model,project,system,ui
```

`release:verify` 只读取当前 checkout、官方 origin 与发布拓扑，确认本地/远端 tag、HEAD、
工作树、包版本和锁文件身份；它不安装、不构建、不发布。该命令与真实发布都要求命令行显式
传入 tag，不接受托管运行器的事件或 ref 环境作为发布身份。

`--only` 沿用现有发布拓扑的规则：只收窄整列 tag 的包集合，全量声明、版本与锁文件、平台代和依赖拓扑仍需通过验证。单包 tag 已确定范围，不能再加 `--only`。缺失、重复或未知参数直接失败。`--local-tag` 是真实发布模式；本地模拟仍使用 `bun run release:dry-run`。

发布器依次执行身份和凭据检查、`bun install --frozen-lockfile`、完整 `bun run check`、新构建和逐包发布。冻结安装后、质量门后、新构建后以及每个包真正发布前都会重新核验 `HEAD`、本地及远端 tag、工作树。任一步失败立即停止，真实发布不接受 `--skip-build`。

每个包通过 `safePackPackage` 在独占临时目录中打包。发布器验证 tarball 的包名、版本、可安装依赖和构建产物，记录源码 SHA、tag、文件大小及 SHA256；发布前再次检查字节摘要，`bun publish` 接收的就是该 tarball 路径。现有安全入口的超时、进程组回收和路径保护保持生效。

该入口只发布选定的包。产品依赖安装与验证由各消费者维护；它不运行跨仓更新、创建 PR 或修改 Actions 账单。已经发布的版本不会被覆盖；发布器沿用 `--tolerate-republish`，因此恢复一次中途失败的发布后，应从注册表核实目标版本及实际包内容，再进行消费者冻结安装。

## Document Renderer 原生发布

Document Renderer 只在目标原生系统本机发布。Apple Silicon macOS 只能处理 `darwin-arm64`，Windows x64 只能处理 `win32-x64`，Linux x64 只能处理 `linux-x64`。同一版本后续由另一台原生主机补齐平台时，finalize 会保留已经完成的平台身份，只添加本次平台。

真实发布需要以下仅进程内凭据：

- `VELAROS_RELEASE_REPOSITORY`：公开二进制仓库；未设置时从源码仓库变量读取。
- `VELAROS_RELEASE_REPO_TOKEN`：二进制仓库写入凭据；未设置时使用 `gh auth token`。
- `VELAROS_RELEASE_ATTESTATION_KEY_ID` 与 `VELAROS_RELEASE_ATTESTATION_PRIVATE_KEY`：Ed25519 key id 和 base64 DER PKCS#8 私钥，用于签署本次 catalog。
- 可选的 `VELAROS_RELEASE_ATTESTATION_PUBLIC_KEYS`：逗号分隔的 `keyId:base64-DER-SPKI`，用于验证轮换前的 catalog。

不要把凭据写入仓库、命令参数或日志。macOS 还需设置 `VELAROS_RENDERER_CODESIGN_IDENTITY`（或 `VELAROS_HOST_CODESIGN_IDENTITY`），并准备 `APPLE_KEYCHAIN_PROFILE` 指向的 notarytool profile。凭据就绪后，从干净且已经推送的官方 `main` checkout 执行：

```sh
# Apple Silicon macOS
bun run release:document-renderer:mac --channel stable --check-only
bun run release:document-renderer:mac --channel stable

# Windows x64
bun run release:document-renderer:win --channel stable --check-only
bun run release:document-renderer:win --channel stable

# Linux x64
bun run release:document-renderer:linux --channel stable --check-only
bun run release:document-renderer:linux --channel stable
```

`bun run release:document-renderer --channel stable` 是当前原生主机的等价入口。真实路径依次核验官方 origin、干净工作树和已推送 HEAD，执行冻结安装与完整 `bun run check`，在当前系统构建能力包；macOS 同时做 Developer ID 签名和公证。随后它在 `document-renderer-v<version>` published prerelease 下上传能力包和单平台 staged receipt，生成并上传带 Ed25519 attestation 的 `catalog-document-renderer-v<version>-<channel>.json`，最后上传 `candidate-document-renderer-<channel>.json` 作为完成标记。完成标记始终是最后一次远端写入。

本地产物位于 `release/document-renderer/`，本地 catalog 与完成清单位于 `dist-document-renderer/release/`。传输中断后重复运行同一命令会按源码身份、大小与 SHA-256 复用相同字节；不同字节默认拒绝覆盖，`--replace-existing` 只用于修复已确认损坏的同版本候选。`--dry-run` 只做前置核验，不构建、签名、公证、上传或 finalize。

若只需恢复已完成构建后的传输，可用同一组环境变量显式执行 stage 与 finalize；两条命令必须选择同一个当前原生平台：

```sh
node scripts/document-renderer/release-candidate.mjs stage \
  --channel stable \
  --platforms darwin-arm64 \
  --platform darwin-arm64 \
  --artifact-manifest release/document-renderer/document-renderer-artifact-darwin-arm64.json
node scripts/document-renderer/release-candidate.mjs finalize \
  --channel stable \
  --platforms darwin-arm64
```

Windows 或 Linux 恢复时，将两处平台和 artifact manifest 后缀一起替换为 `win32-x64` 或 `linux-x64`。stage 会重新计算本地字节摘要，finalize 会下载并验证远端能力包摘要、签署 catalog，再写完成标记；不依赖任何 Actions job。

## 本机质量与安全门

提交或发布前运行 `bun run check`。它包含构建、类型检查、lint、测试、依赖审计、架构门以及 Document Renderer 发布回归；源码 workflow 哨兵的零权限、静态跳过和禁用敏感步骤也由测试与两份域架构门校验。

## 回归检查

`bun run check:release-source` 执行不访问注册表的构造测试，覆盖参数、仓库地址、轻量/annotated tag、远端不一致、检查期间身份变化，以及完整质量门的执行顺序和失败传播。该命令已接入 `check:gates`；它本身不会安装、构建或发布任何包。

`bun run check:document-renderer-release` 覆盖本机平台选择、dry run、attestation、分平台 finalize、完成标记顺序和所有 workflow 策略哨兵。测试只使用临时文件与内存 release client，不访问公开发布仓库。
