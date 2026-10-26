# Platform 消费仓升级

Platform 正式归档由 GitHub Actions 完整检查后发布到 GitHub Releases，不自动修改消费仓。消费仓按 release-manifest.json 固定 tag、sourceSha、包版本、大小、SHA-256 与 SHA-512，再验证下载的同一归档。Desktop 使用 resources/runtime-snapshot.json 与 bun.lock 保存这些身份；UI 的独立来源仍由该快照记录。产品所需的源码迁移、安装验证和原生发布由对应仓库负责。

## 旧 GitHub Packages 消费方式

以下定向升级器仅适用于仍从 GitHub Packages 注册表消费的仓库，不适用于 Release tarball 快照。GitHub Release 发布成功不代表同版本已上传注册表；不要将两种来源或摘要混用。

正式消费仓清单位于 `scripts/release/platform-consumers.json`，当前包含 Desktop、Workbench、Termel 和 VelarOS Labs。`scripts/release/sync-platform-consumer.mjs` 是保持的定向升级器，可在 Platform checkout 中显式运行：

```sh
NODE_AUTH_TOKEN="$(gh auth token)" bun scripts/release/sync-platform-consumer.mjs \
  --consumer /absolute/path/to/consumer \
  --release-ref v0.6.26 \
  --only agent,agent-lab,memory,model,project,system,ui
```

单包 tag 已决定唯一升级范围，不再传 `--only`。升级器会：

1. 按发布 tag 和可选 `--only` 还原实际发布的包。
2. 从 GitHub Packages 验证目标版本可读；注册表尚未可见时不修改消费仓。
3. 只替换消费仓清单中的对应直连依赖，保留 `^`、`~` 或 exact 的原有范围意图。
4. 用 Bun 定向刷新锁文件，并拒绝 `file:`、`link:`、`portal:`、`workspace:` 或非 `https://npm.pkg.github.com/download/` 的 Platform 解析。

升级后由维护者在消费仓运行冻结安装和该仓完整质量门，审查清单、锁文件及必要兼容迁移，再精确暂存、提交和推送。升级器本身不建分支、不创建 PR、不写主分支，也不读取 Actions secret。凭据只通过当前进程的 `NODE_AUTH_TOKEN` 提供，权限应限于 GitHub Packages read；不得写入仓库或日志。
