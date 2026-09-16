#!/usr/bin/env node
// velaros 命令的可执行壳：只把进程参数与环境交给 ./dist 的 velarosCliProcess，别的什么都不做。
import { velarosCliProcess } from '../dist/index.js'

process.exitCode = await velarosCliProcess.run({ argv: process.argv, environment: process.env })
