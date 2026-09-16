#!/usr/bin/env node
// 守护进程可执行入口：把进程环境与模块导入函数交给 ./serve 的 kernelDaemonProcess，别的什么都不做。
//
// 动态 `import()` 只出现在这里：装第三方 mod pack 就是「按运行期才知道的路径加载代码」，
// 静态依赖图表达不了它，所以包内一条都不留，由这个在 src 之外的入口注入。
import { kernelDaemonProcess } from '../dist/exports/serve.js'

await kernelDaemonProcess.run({
  environment: process.env,
  importModule: (url) => import(url),
})
