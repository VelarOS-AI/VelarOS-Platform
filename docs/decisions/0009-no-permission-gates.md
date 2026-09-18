# 0009: 能力不设权限闸、不脱敏，只在危险命令上问人

- Status: accepted
- Date: 2026-09-18
- Owners: `@velaros-ai/velar`（files、shell、sandbox、project 四个单元）、`@velaros-ai/system`、`@velaros-ai/project`

## Context

代码面接进来之后，模型在一段程序里连着读、改、跑命令。原来散在各处的权限闸与脱敏开始成片地挡路。用户的原话：
「权限和脱敏这些东西挺恶心的，它会干扰执行不说还会导致模型无法执行某些操作。」

逐条看当时还在的闸：

| 闸 | 在哪 | 实际效果 |
| --- | --- | --- |
| 脱敏 | 项目内核读取、搜索片段、证据包；项目空间的命令输出与镜像里的命令输出 | 读到 `[REDACTED]`，这样的窗口不签 fileRef，文件改不了；命令打出来的东西被改写 |
| 项目修改授权 `prepareMutation` | 每次 edit、undo；项目里每条非只读命令；沙箱落回 | 每一步等人点头，被拒就整批不写 |
| 内核的策略与审批 `decide` | 读、搜、准备、提交、校验之前 | 宿主策略能拒任何一步；回滚恢复不了原文的写入（删二进制文件这类）要人审，宿主没接审批通道就直接拒 |
| 路径名单 | `readDeny`、`writeDeny`（缺省挡 `.git`）、`protectedFiles`、`generatedFiles`（缺省挡 `*.generated.*`、`generated/**`） | 改生成物、改 `.git/info/exclude` 这类正常操作被拒 |
| 宿主的可见性过滤器 | 项目内核 | 点名读 `node_modules` 里的源码也被拒 |
| 系统空间的凭证与敏感路径确认 | `velar:files` 读写 `~/.ssh`、`*.pem`、任何家目录下的点文件、`/etc` | 改 `~/.zshrc`、`~/.gitconfig` 都要确认 |
| 长驻命令确认 | `velar:shell` | 起开发服务器也要问一声 |
| 沙箱落回确认 | `velar:sandbox` | 落回镜像里做好的改动每次都要人点 |

这些闸有一个共同点：**模型手里本来就有 shell**。`cat ~/.ssh/config`、`echo >> ~/.zshrc`、`cp -r mirror/* .`、
`sed -i` 改生成物，都不经任何确认。一道 shell 能绕过去的确认拦不住任何事——它不是边界，只是摩擦；
脱敏更糟：它不挡读取（shell 照样读得到原文），却让模型改不了自己刚读过的文件。

## Decision

拆掉上面表里的全部，只留下真正在挡东西的：

- **危险命令确认照旧**（`velar:shell` 的 run、`velar:sandbox` 镜像里的 run）：递归删除、丢掉未提交改动的 git、提权、格式化磁盘这类，
  每次都由用户亲自点、不记住答案。它挡的是模型自己手滑造成的大面积不可逆破坏——2026-09-15 整个仓库被一个删目录的脚本删掉，就是这一类。
  这是安全铁律，不在这次拆的范围里。
- **空间边界照旧**：项目空间出不了项目根（含经符号链接指到外面），沙箱的命令写不出镜像。它说的是「这个空间管哪儿」，不是权限；
  要碰项目外面的东西用系统空间。
- **正确性核对照旧**：版本过期拒绝覆盖、落盘前核对原字节、沙箱落回核对差量指纹与源目录冲突、事务规模预算、只守内存的上限。
- **风险分级照旧，但只是记账**：回滚恢复不了原文的写入仍记成 high，给界面与审计看，不拦写入、不问人。
- **宿主的过滤器只管列举**：它决定列举、扫描、搜索时哪些条目不出现（噪音），点名读写从不问它。

具体拆掉的：

- `@velaros-ai/velar/project`：脱敏全套（`SecretRedactionProvider`、`createSecretRedactionProvider`、`ProjectRedactionMarker`、窗口的 `redacted`）；
  `ProjectSpacePort.prepareMutation` 与 `ProjectOperationContext.approval`；内核的 `decide`、`PolicyProvider`、`ApprovalProvider`、`projectApprovalBridge`；
  `CorePolicy` 的 `readDeny`、`writeDeny`、`protectedFiles`、`generatedFiles`、`approval`；错误码 `PROTECTED_FILE`、`GENERATED_FILE`；
  内核的 `authorizeWrites`、`redactText`、`prepareContextSnapshot`。
- `@velaros-ai/velar/files`：`FileSpacePort.reviewRead`、`reviewWrite`，`FileOperationContext.approval`，`FileConfirmation`。
- `@velaros-ai/velar/shell`：长驻命令确认（`ShellCommandPlan.shouldRequestConfirmation`、`ShellCommandPolicyApi.confirmationMessage`），`ShellSpacePort.reviewCommand`。
- `@velaros-ai/velar/sandbox`：落回确认（`SandboxSurfacePort.applyPolicy`、`reviewApply`，`SandboxApplyOperationKind`，`SandboxApplyPolicy`、`SandboxApplyRequest`）。
- `@velaros-ai/system`：凭证文件读写确认、系统敏感路径写确认、沙箱落回的敏感路径点名。
- `@velaros-ai/project`：命令输出脱敏、会改项目的命令过修改授权、沙箱落回前的写治理与修改授权。

搜索片段顺带改成以命中为中心取：原来为了「先取宽窗口脱敏再截」，长行里的命中会被从行首截掉看不见。

## Alternatives

- **保留脱敏，只让被遮的窗口也能改**：模型会把 `[REDACTED]` 当原文写回去，或者为了绕开遮挡去 shell 里读原文——多走一步，什么都没挡住。否决。
- **保留确认，按会话记住答案**：第一次照样打断，而且照样绕得过去。否决。
- **连危险命令确认也拆掉**：它是这里唯一挡住过真事故的闸，而且只在极少数命令上出现。保留。

## Security and privacy

- 项目文件、命令输出里的密钥原样进模型上下文，也就原样到了模型提供方。这是用户知情的选择；不想让某些内容出去的，别把它放进挂给模型的空间。
- 被提示注入的模型能做的事没有变多：这些读写 shell 本来就能不经确认做到。挡大面积破坏的仍是危险命令确认。
- `.git` 里的文件经 `velar:project` 也能改了（原来缺省不许写）。改 hooks、config 让内核后续的 git 调用执行命令，这件事 shell 一直都能做。

## Compatibility and migration

破坏性改动，没有过渡：上面列的接口、类型、错误码直接删除。宿主要改的：

- 不再传 `prepareMutation`、`secretRedaction`、`policy`、`approval`，`corePolicy` 里不再有名单与 `approval`；
  `projectApprovalBridge`、`createSecretRedactionProvider` 没了（Desktop 现有的接线在代码面接线时一并去掉）。
- `FileFilterProvider` 只影响列举与搜索；靠它挡点名读取的宿主，点名读取现在会成功。
- 系统空间与项目空间的调用上下文仍要审批端口，只给危险命令用。

## Validation

各单元的不变量登记改写了对应条目，改写原因写在各表头：`velar/files` INV-2、INV-5；`velar/shell` INV-5、INV-7；`velar/sandbox` INV-1～INV-3、INV-5；
`velar/project` INV-10、INV-13、INV-14、INV-17、INV-19；`system` INV-19、INV-20、INV-27、INV-35；`project` INV-2、INV-4、INV-5。
每条都有验收用例钉住「不问、不遮、照常写」，危险命令确认的用例原样保留。

## Consequences

模型在项目里像一个有终端的开发者那样读写：读到的是原文，改得动自己读过的每一行，跑命令不等人，只有危险命令停下来问。
ADR 0006 里「落回前向用户确认」「落回时按源路径重新过一遍敏感路径与凭证审批」两条由本决定取代。
