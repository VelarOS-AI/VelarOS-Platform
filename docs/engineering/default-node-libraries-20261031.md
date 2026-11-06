# 默认 Node 库与验证

默认环境只提供 execa、@vscode/ripgrep、globby 和 diff 四个核心包，分别处理命令、文本搜索、路径查找与文本差异。文件、目录和 JSON 使用 Node 标准库。yaml、fs-extra、cheerio、csv-parse、csv-stringify、lodash-es、date-fns、p-limit、jszip 和 zod 已从基础清单与 Script 直接依赖中删除；实际需要它们的模块自行声明，不为这些库新增 Feature。

typescript、ts-morph 与 prettier 统一由 JS/TS 能力按需提供，基础任务环境不公开；项目已有依赖继续优先，格式化采用项目配置。Script 内部保留合同编译所需的 TypeScript，宿主依赖与模型可导入包目录分别管理。包代码不在宿主启动时执行，Node 实际 import 时才加载；常驻提示只列当前环境包名和简短用途，README/类型通过目录按需读。随产品交付的专项依赖仍占用磁盘，按需装配不表示从安装包中删除。

`NodeDefaultPackages` 是默认目录与打包资源的单一来源，保持工作区版本优先、显式宿主导入、原生子路径和子进程继承。没有增加自定义封装 API，也没有要求普通任务使用 project。

真实 Node 测试覆盖四个核心包、Node 文件及 JSON 处理，并核对主程序与子进程均不能从宿主内部借用已删除的默认库。JS/TS 能力测试另行覆盖加载后的 TypeScript 结构修改、编译及 Node 子进程继承。Desktop 的独立资源探针分别核验四个基础包与专项依赖。

## 依赖问题证据

安装审计报告 GHSA-g3hv-75wg-m249：minimatch 10.2.6 的优化阶段可能放大输入，见[官方公告](https://github.com/advisories/GHSA-g3hv-75wg-m249)及[上游修复](https://github.com/isaacs/minimatch/commit/77a0f5c)。回移上游模式数量限制和大型集合跳过二次去重的修复到 ESM/CommonJS 两个入口，保持旧 API；ts-morph 的修复依赖闭包随 JS/TS Skill 打包。旧的 3.1.5、5.1.9 没有该优化阶段，按实际源码哈希逐份核对。安全门先校验所有可达副本的内容身份及行为，再处理版本范围公告；新增版本、漏补丁或内容变化均使检查失败。没有全局强行升级旧调用方到不同 API。

本轮按用户要求只提交源码、不发布。project 强制使用与按需使用的真实任务对照另行记录，统一 Velar Dev GPT-5.6 Sol，不能把本地库功能测试当成模型效率结论。

Desktop 联调发现新增库说明使常驻指令超过原有 3800 字符预算。保留预算，压缩重复用途和验证说明，继续保留测试发现、真实入口、消费入口及按变更补验的要求；未通过提高长度上限放行。标准 Node 回归与模块所有权检查通过，完整 Desktop 接缝检查另在该仓记录。
