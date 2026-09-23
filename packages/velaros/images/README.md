# @velaros-ai/velaros/images

看图能力：代码面 `velaros:images` 的 `view`，把 PNG、JPEG、GIF、WebP 交到模型眼前，返回值里只有尺寸。系统空间和项目空间挂同一份实现，差别全在空间端口：本机端口在 `./local`，项目里的用 `@velaros-ai/velaros/project` 的 `projectCapabilityPorts.images`。

## 用法

```ts
import { createCapabilityModule } from '@velaros-ai/velaros'
import { imageOperations, type ImageAttachment, type ImageOperationContext } from '@velaros-ai/velaros/images'
import { VelarImagesModule } from '@velaros-ai/velaros/images/contracts'
import { createLocalImagePort } from '@velaros-ai/velaros/images/local'

// 路径怎么解析由宿主定：系统空间把 ~ 展开到家目录、相对路径相对工作目录
declare function resolveSystemPath(path: string): string
const images = createLocalImagePort({ resolvePath: resolveSystemPath })

// 宿主自己调用（界面、测试）：图经 attachImage 交出来，结果里只有尺寸
const shown: ImageAttachment[] = []
const context: ImageOperationContext = {
  abortSignal: new AbortController().signal,
  images,
  attachImage: (image) => shown.push(image),
}
const result = await imageOperations.view({ files: [{ path: '~/Desktop/shot.png' }] }, context)
for (const file of result.files) {
  if ('error' in file) console.warn(file.path, file.error.code, file.error.message)
  else console.log(file.width, file.height, file.sent)
}

// 挂成模型程序里可以 import 的 velaros:images：图交给代码面的图片通道，跟在结果后面给模型看
export const imagesModule = createCapabilityModule({
  surface: VelarImagesModule,
  implementation: imageOperations,
  instanceId: 'system-images',
  context: (call) => ({
    abortSignal: call.signal,
    images,
    attachImage: (image) => call.attach({ type: 'image-data', ...image }),
  }),
})
```

## 入口

| 入口 | 运行环境 | 内容 |
| --- | --- | --- |
| `@velaros-ai/velaros/images` | Node | `imageOperations`、空间端口 `ImageSpacePort` 与调用上下文、端口上流动的数据 |
| `@velaros-ai/velaros/images/contracts` | 任何进程 | 上限 `ImageLimits`、`view` 的入参与结果、模型面 `VelarImagesModule` |
| `@velaros-ai/velaros/images/local` | Node | 本机看图端口 `createLocalImagePort` |

## 约定

- 路径解析、越界与许不许看都由空间端口的 `locate` 决定，越界抛 `PERMISSION`；本机端口不设范围，读解开符号链接之后的文件。
- 宿主不给 `attachImage` 时整个 `view` 不可用（`PLATFORM`），一个文件都不读；图只经这个通道交出，结果里没有像素。
- 在 `ImageLimits.edge` 与 `ImageLimits.base64Bytes` 以内、又没要 `region` 的图原样交出；超限或要 `region` 才请端口的 `resizeImage`。本机端口只在 macOS 上给这个口子（系统自带的 sips），别的平台这两种请求报 `PLATFORM`，message 里给出能用的缩图命令。
- 一批最多 `ImageLimits.viewFiles` 张，单个文件最大 `ImageLimits.fileBytes` 字节，按文件头认格式；入参形状不对整批拒（`VALIDATION`），某一张看不了只标记那一项，全部失败才抛第一个失败。
