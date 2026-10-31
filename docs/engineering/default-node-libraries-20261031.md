# 默认 Node 库与验证

默认环境从 5 个包扩展到 17 个包。普通文件操作继续遵循 Node 语义，模型可直接使用 fs-extra、ts-morph、typescript、prettier、cheerio、csv-parse、csv-stringify、lodash-es、date-fns、p-limit、jszip 和 zod。它们提供文件便利操作、源码修改、格式化、网页数据解析、表格交换、数据整理、日期、并发限制、压缩与数据校验。

ts-morph/prettier 原先属于按需加载的 JS/TS Skill，现在基础环境也可直接导入，沿用相同版本；高级 Skill 的语言能力与其他工具继续按需加载。typescript/zod 已是运行依赖，此次加入可发现的默认目录。包代码不在宿主启动时执行，Node 实际 import 时才加载；常驻提示只列包名和简短用途，README/类型通过目录按需读。预装占用磁盘，不能据此承诺零内存成本或所有任务都会加速。

`NodeDefaultPackages` 是默认目录与打包资源的单一来源，保持工作区版本优先、显式宿主导入、原生子路径和子进程继承。没有增加自定义封装 API，也没有要求普通任务使用 project。

真实 Node 测试覆盖文件 JSON、TypeScript 结构修改与编译、格式化、HTML、含引号和换行的 CSV、分组、日期、并发上限、ZIP 和 zod 校验；原有基础包与 JS/TS Skill 测试继续通过。Desktop 的独立资源探针验证打包后不依赖工作区也能加载这些库。

## 依赖问题证据

安装审计报告 GHSA-g3hv-75wg-m249：minimatch 10.2.6 的优化阶段可能放大输入，见[官方公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)及[上游修复](https://github.com/isaacs/minimatch/commit/77a0f5c)。回移上游模式数量限制和大型集合跳过二次去重的修复到 ESM/CommonJS 两个入口，保持旧 API；ts-morph 的修复依赖闭包随 Script 和 JS/TS Skill 打包。旧的 3.1.5、5.1.9 没有该优化阶段，按实际源码哈希逐份核对。安全门先校验所有可达副本的内容身份及行为，再处理版本范围公告；新增版本、漏补丁或内容变化均使检查失败。没有全局强行升级旧调用方到不同 API。

本轮按用户要求只提交源码、不发布。project 强制使用与按需使用的真实任务对照另行记录，统一 Velar Dev GPT-5.6 Sol，不能把本地库功能测试当成模型效率结论。
