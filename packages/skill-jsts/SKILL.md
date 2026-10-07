---
name: jsts
description: JS/TS 项目开发与验证。
---

使用项目自己的 package.json、tsconfig、格式化配置和已有验证命令。标准 npm 包直接 import；实际版本、README、类型入口在运行目录的 packages 中按需查阅。

修复问题时先建立可复现依据，修改后运行相关测试与类型检查，交付前完成项目要求的检查。检查结果应对应最终代码；失败保留命令、退出码和日志入口。

项目语言服务由宿主绑定的 velaros:code 统一查询入口提供。网页测试使用项目的 Playwright 配置和测试环境；浏览器二进制按任务需要准备。
