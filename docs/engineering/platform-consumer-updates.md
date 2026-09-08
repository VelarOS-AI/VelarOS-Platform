# Platform 消费仓本机升级

Platform 包通过 `bun run release:local <tag> [--only ...]` 从维护者本机发布。`.github/workflows/release-packages.yml` 是静态跳过的策略哨兵，不发布包，也不自动修改消费仓。包在 GitHub Packages 可读后，维护者再逐个消费仓执行升级；这样产品所需的源码迁移、原生构建和发布仍由对应仓库及原生主机负责。

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
