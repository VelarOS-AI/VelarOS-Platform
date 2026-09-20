# @velaros-ai/velaros/images 模块卡片

> 这一页是本模块的压缩表示：读完就知道它是什么、给了外面什么、骨干链路怎么走、靠什么、状态在哪、失败什么样、哪些承诺不能破。
> 模型面是 `baselines/script/images.d.ts`（由 `@AgentView` 从 `ImageOperationsApi` 与它引用的类型生成），那是模型看到的全部。
> 先看 `impl/ImageOperations.ts` 类上方的接口（`contract/provides.ts` 登记它），本机看图端口看 `impl/LocalImagePort.ts`；utils 里每个函数上方有一句说明。
> 门禁：`bun run check:module-ownership`、`bun run check:script`。

## 这是什么

所有空间共用的看图能力：代码面 `velaros:images` 的 `view`。

**能力不绑空间**：只有这一份实现，每个空间注入自己的 `ImageSpacePort`——路径怎么解析、越界算不算、许不许看、由谁裁图缩图，都在端口里。
看图是真正「两个空间里是同一件事」的能力，所以从本机文件能力（`@velaros-ai/velaros/files`）里拆出来单独成包，系统空间与项目空间挂同一份；
文本文件的读写不在这里——本机文件与项目文件是两件能力，各有各的包。

**本机实现也在这里**（`./local` 入口，只给 Node）：本机看图端口 `createLocalImagePort`——路径怎么解析由宿主给的 `resolvePath` 定，读解开符号链接之后的那个文件；
macOS 上用系统自带的 sips 裁图缩图（裁与缩分两次调），别的平台不给缩图口子。项目里的看图端口在 `@velaros-ai/velaros/project` 的 `projectCapabilityPorts`。
装空间是产品的事（ADR 0013）。

## 提供什么

**产品面**，登记在 `contract/provides.ts`：

| 值 | 接口 | 做什么 |
| --- | --- | --- |
| `imageOperations` | `ImageOperationsApi` | 代码面 `images` 命名空间的 view：把图交到模型眼前，返回值里只有尺寸 |
| `ImageLimits` | 契约常量 | 公开上限：一批几张、读进来的文件多大、交给模型的图的长边与 base64 字节 |
| `createLocalImagePort` | `ImageSpacePort`（requires；`./local` 入口） | 本机看图端口：任意位置、解开符号链接；macOS 上给 sips 缩图，别的平台不给 |
| `VelarImagesModule` | 生成的合同（`contract/surface.ts`） | `velaros:images` 随包发布的模型面：模块名、放出去的方法、生成的完整声明（与 `baselines/script/images.d.ts` 同一份）；空间挂这件能力时交给代码面的门 |

**数据面**是 `types/`：`types/images.ts` 是可移植数据（view 的入参与结果），`types/space.ts` 是空间端口上流动的数据
（定位出来的一张图、裁图缩图的请求与结果、交给模型看的一张图，带 `Buffer`，从根入口导出）与看图的工作类型（不出包）。

三个入口对应包清单 `exports` 里的 `./images`、`./images/contracts` 与 `./images/local`，源文件是单元目录上的 `index.ts`、`contracts.ts` 与 `local.ts`，只有转发语句：

| 入口 | 给谁用 | 里面有什么 |
| --- | --- | --- |
| `./images` | Node 宿主 | view、空间端口、本机看图端口的配置、它们用到的数据 |
| `./images/contracts` | 任何进程，含浏览器 | 常量表与可移植数据 |
| `./images/local` | Node 宿主 | 本机看图端口的工厂 `createLocalImagePort` |

**注入面**在 `contract/requires.ts`：

| 接口 | 谁给、什么时候给 |
| --- | --- |
| `ImageSpacePort` | 每个挂 `velaros:images` 的空间一份：`locate`（作用域与读取策略：真正要读的文件、交给模型时的写法，越界或不许读就抛 `PERMISSION`）、可选的 `resizeImage`（宿主的图像处理） |
| `ImageOperationContext` | 宿主每次分发 `images` 命名空间的调用时装好：取消信号、上面那个端口、可选的交图通道 |
| `LocalImagePortOptions` | 建本机看图端口时必须：`resolvePath`（把模型给的路径解析成绝对路径），可选的平台（决定给不给 sips 缩图） |

## 骨干链路

| 能力 | 链路 |
| --- | --- |
| 看 `view` | `imageOperations.view`：核对取消信号 → `viewItems` 核对形状、条数与 region → 没有交图通道直接拒 → 每张图：`ctx.images.locate` → `readImageFile`（普通文件、20 MB 上限）→ `detectMediaType` 只认 PNG、JPEG、GIF、WebP → `readImageSize` 读头拿宽高 → `clampImageRegion` 收拢 region（整块在图外就拒）→ 在上限以内又没要裁的原样交出；否则 `shrinkImageToLimits` 请 `ctx.images.resizeImage` 裁、缩（base64 还超就收长边重试）→ `ctx.attachImage` 交出图与一行说明，结果里只有尺寸 → 某一张失败只标记它，全部失败才整个抛第一个失败 |

## 依赖什么

- 上游包：`@velaros-ai/core`（类型守卫、`AppError`、日志、真实路径）、`@velaros-ai/core/platform`（规整用户输入的路径）、`@velaros-ai/core/text-files`（有界读）。
- 只在验收里用：`@velaros-ai/script`（dev 依赖），跑端到端的程序、给代码模版做类型检查。
- 用到的 Node 内置模块：`fs/promises`（stat；sips 的临时文件）、`child_process`（调 sips）、`os`、`path`、`util`。只在根入口与 `./local` 的引用链上；`./contracts` 不碰。
- 不读环境变量。

## 状态归谁

无状态：每次调用读、判、交，不留任何东西。

## 生命周期

没有需要释放的东西。

## 失败语义

- 一批里某一张失败只标记它（`{ path, error: { code, message } }`），全部失败才整个抛第一个失败。
- 形状不对、条数不对、文件太大、不是能看的图片、region 整块在图外：`VALIDATION`。找不到文件：`NOT_FOUND`。越出范围、不许读、没有权限：`PERMISSION`。宿主做不了（没有交图通道、压不了图、裁不了图）：`PLATFORM`，message 里给出能用的命令。
- 代码面只把 `code` 与 `message` 交给程序，所以模型要知道的都写在 message 里。

## 不变量

共 15 条，登记在 `spec/invariants.md`，验收用例在 `spec/acceptance.test.ts`。编号只增不重排。INV-15 是本机看图端口用 sips 裁图缩图的承诺，随实现从 `@velaros-ai/system` 搬来（原 INV-34，ADR 0013）。
按检验方式：测试 14 条、门禁 1 条。未验证 0 条。

## 非目标

- 不决定作用域与策略：路径相对谁、越界算不算、许不许看，全由空间注入的 `ImageSpacePort` 说了算。
- `view` 不做图像处理：裁、缩交给端口（本机看图端口在 macOS 上用 sips）；端口没有这个能力就明说。
- 不装空间：哪个空间挂 `velaros:images`、能看哪儿的图，是产品的事（ADR 0013）。
- 不读文本、PDF 与其他文档：文本文件归读文件的能力（系统空间 `velaros:files`、项目空间 `velaros:project`），文档另有能力。

## 结构

```text
images/
  contract/     对外合同：provides.ts 登记 view 的 API，requires.ts 是空间端口与调用上下文，constants.ts 是公开上限；surface.ts 是生成的模型面（随包发布的声明）
  types/        只放类型：images.ts 是可移植数据，space.ts 是空间端口上的数据与看图的工作类型
  impl/         一类一文件：ImageOperations（velaros:images）、LocalImagePort（本机看图端口）
  utils/        image.ts（认格式、读宽高、有界读、区域、压进上限）、input.ts（入参核对）、sips.ts（macOS 上用 sips 裁图缩图）、tuning.ts（可调参数）；全是函数与常量，每个函数上方一句说明
  index.ts      `./images` 入口，只转发
  contracts.ts  `./images/contracts` 入口，只转发
  local.ts      `./images/local` 入口，只转发
  template.js   代码模版：日常用法的示例程序，随模型面发布、按需读，不嵌进声明
  spec/         不变量登记、验收测试、共用的真磁盘空间端口
  test/         实现细节测试
```

**分层。** 只有一层：`ImageOperations.ts`（代码面的 view）与 `LocalImagePort.ts`（本机看图端口），互不依赖。

**类与接口。** 每个类实现一个接口，定义在类文件里、紧挨在类的上方并导出；公开的在 `contract/provides.ts` 登记。整个进程只需要一份的，文件末尾给出那一份，按公开接口标注类型。

| 实现文件 | 接口 | 做什么 |
| --- | --- | --- |
| `ImageOperations.ts` | `ImageOperationsApi`（同文件，provides 登记） | 代码面 `images` 命名空间的 view |
| `LocalImagePort.ts` | `ImageSpacePort`（requires） | 本机看图端口：定位与 sips 缩图 |
