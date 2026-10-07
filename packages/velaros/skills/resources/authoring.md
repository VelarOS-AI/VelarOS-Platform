# VelarOS Skill 开发规范

Skill 是 Node Agent Runtime 的可安装扩展包，可以组合按需说明、资源文件、标准 npm 依赖与外部能力。
基础环境提供 Node.js、execa、@vscode/ripgrep、globby、diff、yaml。标准库与 npm 包直接按原始 API 使用，版本、README 和类型声明可从运行环境目录按需查询。
标准 npm 包沿用自身 API；只有系统特有的安装、权限、资源生命周期和外部能力接入才使用自定义接口。

## 选择最小包结构

纯说明只需要 SKILL.md，开头包含 YAML frontmatter：

```markdown
---
name: guided-review
description: 根据实际 diff 审查代码，并给出可以定位和验证的问题。
---
读取任务涉及的变更和调用链，优先报告可以复现的问题。
```

安装时在暂存目录生成版本 0.0.0 的 package.json；来源目录保持原样。
需要版本、npm 或外部能力时，使用标准 package.json 加 agentSkill：

```json
{
  "name": "semver-tools",
  "version": "1.0.0",
  "description": "提供标准 semver 包",
  "type": "module",
  "dependencies": { "semver": "7.8.5" },
  "agentSkill": { "packages": ["semver"] }
}
```

agentSkill 允许 instructions、packages、capabilities 三个字段，至少贡献一种能力。
instructions 是包内说明文件路径。packages 是向 Agent 公开的 npm 裸包名，必须是本包或 dependencies 的直接依赖；本包的 JS 导出照常使用 exports。
依赖默认私有。需要复现安装时保留 package-lock.json，安装器据此使用 npm ci，否则使用 npm install；安装器使用产品自带 Node/npm。
可以使用 engines.node 声明兼容范围。包内路径用相对路径，不能越界；来源 node_modules 与 .git 不参与安装。
包中不要放凭据、缓存或私人数据。普通资源保存在包内，由 Node 按需读取。

## 说明的写法

description 简述适用任务，SKILL.md 写必要流程、输入、完成条件和资源入口。
标准包的常规用法无需重写。运行目录 $VELAROS_HOST_DIR/index.json 的 packages 提供实际版本、原包根目录、packageJson 和可用的 readme；版本不确定时读取原包文档、类型声明或实现。
复杂参考资料拆成独立文件，正文只留相对链接。安装发现只列元数据，正文由 当前会话选中后由 load({name}) 按需返回。

## 外部能力

需要进入 Kernel 的宿主能力时声明：

```json
{
  "name": "team-directory",
  "version": "1.0.0",
  "type": "module",
  "agentSkill": {
    "instructions": "SKILL.md",
    "capabilities": [
      { "module": "skill:team-directory", "entry": "provider.mjs", "contract": "provider.d.ts" }
    ]
  }
}
```

模块名使用 skill: 加小写字母、数字或连字符，以字母开头。velaros: 保留给系统。
provider.d.ts 必须自包含，只导出具名函数；函数接受零个或一个 JSON 参数并返回 JSON 值或 Promise。
输入需要多个字段时封装为一个对象。声明文件不能引用其他包、import 类型、reference 指令或重载。
每个操作明确写 @OperationEffect none 或 write；写操作加 @OperationModes execute。

```ts
/** 查询服务目录中的团队成员。
 * @OperationEffect none
 */
export function find(input: { query: string }): Promise<{ name: string; email: string }[]>;
```

provider.mjs 导出同名实现，可以使用 Node、fetch 和自己的私有依赖。实现进入受控 Node 子进程，每次能力调用重新核对授权；主进程只读取静态合同。
能力进程的工作目录是当前工作区，包内资源用 new URL('./resource.json', import.meta.url) 定位。
通过 Node/fs/npm 进行的操作遵循会话的操作系统沙箱；Skill 的 grants 只控制 Kernel 能力桥。能力进程没有其他宿主模块授权。
不要用外部能力重复封装标准文件读写、命令执行或 npm API。

## 开发、验证与交付

1. 从 velaros:skills 的 guide({topic:'example'}) 取得可用示例，使用 Node 将 files 写入一个新的工作目录。
2. 实现所需说明、资源或代码，运行针对实际行为的验证。
3. 调用 validate({directory})。它只核验清单、路径、资源、Node 兼容性与合同，不下载依赖、不执行包代码、不写入来源。
4. 调用 install({directory})，由宿主确认后安装。安装会验证完整依赖和内容收据，成功才原子发布；失败保留旧版。
5. 在聊天框「+」选择该 Skill，下一次发送通过 list() 核对状态，load({name}) 读取说明，直接 import 已公开的 npm 包或已授权能力，并验证结果。

安装加入本机库。会话选择决定加载的版本和能力，升级后重新选择新版本。依赖生命周期脚本默认关闭，确需脚本时显式传 allowDependencyScripts: true，由宿主确认。
查询管理、生效时机与卸载方式用 guide({topic:'management'})。


## 内置 Skill 与专项 Skill

project、browser 是内置 Skill。工作区绑定项目根或浏览器会话，并选择默认 Skill。jsts 提供 ts-morph、prettier、jsonc-parser、@ast-grep/napi 和 @playwright/test；选择后直接 import 原包。

`agentSkill.hostCapabilities` 可以声明需要宿主绑定的能力，例如 `velaros:browser`；标准依赖仍写在 dependencies。声明是需求，宿主根据当前资源与会话授权决定是否提供。语言扩展身份 `project:language:jsts` 将宿主的 JS/TS 语言服务加入该轮项目查询。

内置身份由宿主注册处提供，package.json 字段不能将普通安装包提升为内置来源。开发者继续使用普通 npm 包清单、可选 SKILL.md 和原有外部能力入口。
