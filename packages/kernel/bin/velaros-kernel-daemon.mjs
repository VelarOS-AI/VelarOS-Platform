#!/usr/bin/env node
// 守护进程可执行入口：只把进程环境交给 ./serve 的 kernelDaemonProcess，别的什么都不做。
import { kernelDaemonProcess } from '../dist/exports/serve.js'

await kernelDaemonProcess.run({ environment: process.env })
