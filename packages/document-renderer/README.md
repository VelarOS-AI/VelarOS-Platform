# Velar Document Renderer

独立安装的文档渲染能力包：把 Office 文档与 PDF 页渲染成预览页或位图。
它不是 VelarOS Terminal 的模块，不进工具目录，有自己的原生依赖与发布节奏。宿主不 import 它，而是按命令协议调用
`products/document-renderer` 打出来的可执行文件。

## 命令协议

一个进程恰好收一条 JSON 请求、回一条 JSON 回执：请求可以走标准输入，也可以用 `--request-json` 传；
`velar-document-renderer describe` 让它自报协议版本、包版本与支持的格式。
任何一种坏输入（参数缺失、JSON 语法错、标准输入不是 JSON）同样回一条带错误码的 JSON 回执，退出码 1。

回执里的错误码只有四个，调用方按码判断，不按文字：

- `INVALID_REQUEST`：请求不合法（字段缺失、值越界、JSON 语法错）。
- `PATH_DENIED`：路径被拒，见下一节。
- `UNSUPPORTED_FORMAT`：扩展名不在格式表里，或这一页 PDF 渲染不出来。
- `RENDER_FAILED`：解析、渲染、落盘出错。

支持的操作：

- `render-office`：`.docx`、`.pptx`、`.xlsx` 渲染成 `.html` 或 `.png`。
- `render-pdf-page`：`.pdf` 的一页渲染成 `.png`。

## 路径都关在 projectRoot 里

请求里的三条路径（`projectRoot`、`inputPath`、`outputPath`）解开符号链接之后都必须仍在 `projectRoot` 内，
名字以 `..` 开头的目录（例如 `..cache`）照常算在里面。判定在建目录之前：越界时 `projectRoot` 之外一个目录都不会被建出来，
`outputPath` 本身是符号链接时直接拒绝，链接指向的文件一个字节都不动。

## 打包与签名

macOS 上本地开发包可以用 ad-hoc 签名：

```sh
node scripts/document-renderer/build-product.mjs --adhoc
```

Developer ID 构建要显式给出签名身份 `VELAROS_RENDERER_CODESIGN_IDENTITY`（或共用的 `VELAROS_HOST_CODESIGN_IDENTITY`）；
出公证候选包时加 `--notarize`，`APPLE_KEYCHAIN_PROFILE` 选 notarytool 的配置，缺省是 `velaros-notary`。
打包脚本会跑一次 `describe`，核对可执行文件报的产品名与版本对不对得上 `package.json`。

## 在本仓里怎么用

包是 `private`，不发 npm，也不装出命令：本仓开发时直接跑产品那一侧的入口。

```sh
bun products/document-renderer/src/bin.ts describe
```

结构、不变量与对外入口见 `MODULE.md` 与 `spec/invariants.md`。
