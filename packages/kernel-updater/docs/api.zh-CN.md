# `@velaros-ai/kernel-updater` 中文接口文档

## 定位与非目标

本包负责共享 Kernel 运行时在用户机器上的安装、升级、激活与回滚：枚举已安装版本、解析更新清单、按平台/架构挑选产物、校验摘要、并行安装到 `versions/<version>/`、原子切换 `current.json`、失败回滚、清理旧版本。

它只管理磁盘上的字节和一个"当前版本"指针。它不调用任何 capability，不认识任何产品 UI，也不负责启动或停止 Kernel 进程——进程生命周期由 Launcher 与 `@velaros-ai/kernel-service` 决定。它同样不实现真实的签名验签和压缩包解包，这两处只提供注入点。

## 安装

```bash
npm install @velaros-ai/kernel-updater
```

包为 ESM，要求 Node.js 20 或更高版本。运行时依赖只有 `zod`，其余全部使用 Node 内置模块。

## 公共入口

稳定入口为 `@velaros-ai/kernel-updater`。它导出门面 `KernelUpdater`、安装目录布局、更新清单 schema 与选择函数、下载与校验、更新锁、激活指针、安装记录、签名与解包扩展点、错误层级和版本匹配工具。

## 核心类与接口

- `KernelUpdater`：Launcher 面向的唯一门面，提供 `ensureInstalled`、`ensureCompatible`、`activateVersion`、`rollback`、`pruneVersions` 与查询方法。
- `KernelInstallLayout`、`createKernelInstallLayout`：安装根目录及其派生路径；根目录可注入，默认按操作系统选择数据目录，`VELAROS_KERNEL_HOME` 可覆盖。
- `KernelUpdateManifestSchema`、`parseKernelUpdateManifest`、`loadKernelUpdateManifest`：更新清单的 zod 契约与加载。
- `resolveKernelArtifactTarget`、`selectKernelArtifact`、`selectKernelManifestVersion`：平台/架构目标解析与产物选择。
- `downloadKernelArtifact`：流式下载并校验字节数与 SHA-256。
- `KernelUpdateLock`、`withKernelUpdateLock`：跨进程排他更新锁。
- `KernelActivePointerSchema`、`readKernelActivePointer`、`writeKernelActivePointer`：`current.json` 的读写。
- `KernelInstalledVersion`、`listKernelInstalledVersions`：已安装版本清单与完整性状态。
- `KernelArtifactSignatureVerifier`、`KernelArtifactExtractor`：签名与解包扩展点。
- `KernelUpdaterError`、`KernelUpdateLockError`、`KernelArtifactVerificationError`：稳定错误层级。

## 生命周期/并发

磁盘布局如下：

```
kernel/
├── versions/<version>/
├── current.json
├── runtime/
├── data/
├── backups/
├── .staging/
└── update.lock
```

典型顺序是 `ensureCompatible`（或 `ensureInstalled` → `activateVersion`）→ 健康检查 → 必要时 `rollback` → `pruneVersions`。

所有写操作都在排他锁 `update.lock` 内执行：同一实例的并发调用先在进程内排队，跨进程竞争直接抛出 `KernelUpdateLockError`，不会写坏任何状态。锁文件记录持有者 pid；持有者进程已死时锁被回收，进程仍存活时拒绝获取。

安装先落到 `.staging/<version>-xxxx/`，完成后写入 `.kernel-install.json`，最后用一次 `rename` 移入 `versions/<version>/`。因此观察者只会看到"没有"或"完整"两种状态；中途崩溃或中断只会留下 `.staging/` 残留，既有版本与激活指针不受影响，下一次持锁的更新会清掉残留。绝不覆盖当前激活的版本目录。

`current.json` 用"临时文件 + rename"整体替换，内容包含 `version`、`previousVersion`、`updatedAt`、`updatedBy`。切换前的指针会备份到 `backups/`。传入健康检查时，先切指针再执行检查；检查返回 false 或抛错则把指针恢复成切换前的原值，再抛出 `HEALTH_CHECK_FAILED`。

## 依赖注入

`KernelUpdaterOptions` 注入全部外部依赖，因此测试与离线环境都不需要真实网络：

- `root` / `layout`：安装根目录或完整布局。
- `fetch`：`KernelFetch` 字节源，manifest 与产物都走它；默认实现用全局 `fetch` 处理 `http(s)`，其余按本地路径读取。
- `extractor`：`KernelArtifactExtractor`，默认把产物当作单个不透明文件落盘。
- `signatureVerifier` 与 `requireSignature`：`KernelArtifactSignatureVerifier` 注入点，默认实现把所有产物报告为未验签。
- `platform` / `architecture` / `target`：覆盖运行时平台与架构。
- `manifestSource`、`retainedVersions`、`holderId`、`now`、`isProcessAlive`：清单地址、保留版本数、锁持有者标识、时钟与进程存活判定。

健康检查由调用方以异步谓词形式提供，更新器只负责在激活后运行它并按结果回滚。

## 错误模型

所有失败都是 `KernelUpdaterError`，携带机器可读的 `code` 与 `details`。`code` 取值：`ARTIFACT_NOT_FOUND`、`ARTIFACT_SIZE_MISMATCH`、`DIGEST_MISMATCH`、`DOWNLOAD_FAILED`、`HEALTH_CHECK_FAILED`、`INSTALL_FAILED`、`INVALID_MANIFEST`、`INVALID_POINTER`、`INVALID_VERSION`、`INVALID_VERSION_RANGE`、`MANIFEST_UNREACHABLE`、`NO_ROLLBACK_TARGET`、`SIGNATURE_REJECTED`、`UNSUPPORTED_TARGET`、`UPDATE_LOCK_HELD`、`VERSION_NOT_INSTALLED`、`VERSION_UNAVAILABLE`。

更新竞争是独立的 `KernelUpdateLockError`（`UPDATE_LOCK_HELD`），字节校验失败是 `KernelArtifactVerificationError`。校验失败会删除临时文件，安装失败会清掉暂存目录，两者都不改动既有版本与指针。

## 最小第三方示例

```ts
import { KernelUpdater } from '@velaros-ai/kernel-updater'

const updater = new KernelUpdater({
  root: '/opt/velaros/kernel',
  manifestSource: 'https://updates.example.com/kernel.json',
  retainedVersions: 3,
})

const outcome = await updater.ensureCompatible({
  range: '^1.2.0',
  healthCheck: async ({ version }) => probeKernel(version),
})

if (outcome.activated) {
  console.log(`Kernel ${outcome.version} is now active`)
}

await updater.pruneVersions()
```

回滚与查询：

```ts
for (const installed of await updater.listInstalledVersions()) {
  console.log(installed.version, installed.active, installed.complete)
}

const pointer = await updater.rollback()
console.log(pointer.version, pointer.previousVersion)
```

## 扩展点

- `KernelArtifactExtractor`：接入 `tar.gz`、`tar.zst`、`zip` 等真实解包实现；实现只能写入 `destinationDirectory`。
- `KernelArtifactSignatureVerifier`：接入真实验签（在摘要校验之后、暂存之前调用）；配合 `requireSignature: true` 使未验签产物被拒绝。
- `KernelFetch`：接入代理、镜像、断点续传或企业内网分发。
- `KernelHealthCheck`：由 Launcher 决定"新版本是否可用"的判定标准。
- `KernelInstallLayout`：为产品私有 Kernel 指定独立根目录。

## 兼容策略

`current.json`、`.kernel-install.json` 与更新清单都带 `schemaVersion`，属于跨版本磁盘契约：同一 major 内只增加可选字段，改变既有字段语义需要迁移说明。清单新增平台/架构目标时，老版本更新器会以 `ARTIFACT_NOT_FOUND` 明确失败而不是误装。公共 API 与错误码按 SemVer 演进；新增可选注入点保持兼容，删除或改变错误码属于破坏性变化。更新器不会为某个产品或某个能力增加特例。
