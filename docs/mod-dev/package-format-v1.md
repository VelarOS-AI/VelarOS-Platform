# `.velarmod` 包格式与校验

交付文件是 ZIP 格式的 `.velarmod`，包根包含 `velaros.mod.json`。公共解析入口是 `@velaros-ai/kernel` 的 `velarosModEnvelopes.parse(input, {origin})`，返回成功信封或 diagnostics。

```json
{
  "module": {
    "id": "example:hello",
    "version": "1.0.0",
    "apiVersion": 1,
    "provides": [],
    "requires": [],
    "optionalRequires": [],
    "permissions": [],
    "isolation": "in-process",
    "entry": "dist/index.js",
    "exportName": "default"
  }
}
```

module 由 Kernel 校验：版本为三段版本号；apiVersion 为正整数；isolation 为 in-process、worker 或 remote；entry/exportName 可选，其实际寻址取决于装载方式。静态入口应导出 KernelModuleDefinition，由 manifest 和 activate 构成。provides/requires 使用能力身份及版本约束。

agent、ui 为可选的不透明节，接入方负责其字段语义。agent.id 存在时必须与 module.id 一致。解析错误使用 mod.envelope-invalid，身份冲突使用 mod.envelope-id-mismatch。

## 仓库打包命令

```sh
bun run mod pack ./my-mod ./my-mod.velarmod
bun run mod inspect ./my-mod.velarmod
bun run mod validate ./my-mod.velarmod
```

bundled 构建可传 `--bundled`。打包和检查使用 `scripts/mod/velaros-mod.mjs`：压缩包上限 32 MiB，展开上限 128 MiB，最多 512 个文件，单项压缩比上限 100。校验还覆盖危险路径、符号链接及规范化后的重名。实际阈值和检查次序以该脚本为准。

打包通过只证明容器和清单符合规则。宿主还负责来源验证、权限决定、代码加载隔离和安装生命周期；清单中的 trust 信息属于作者声明。运行时验证必须在真实加载的 Kernel 模块及其 Act 装配上完成。
