# 0023: 读出来是连续正文，改的时候按路径写

- Status: accepted
- Date: 2026-09-27
- Owners: `@velaros-ai/velaros`（`velaros:project`、`velaros:files`）

## Context

`velaros:project` 的 read 交回逐行的 `[行号, 正文]` 和一个 `fileRef`；edit 凭 `fileRef` 按行号（`range`）或原文（`match`）改，
只读过几行的 `fileRef` 只许改那几行，整份替换要一个覆盖全文的 `fileRef`，读完之后文件变了就整批拒绝、给新行号让模型重提。
`velaros:files` 同理：read 交回 `[行号, 原文]` 与 `version`，按行号改必须带上 `version`。

真跑长任务时，模型改一处要先读、抄 `fileRef`、数行号、拼 `edits`，写起来比改文件本身还费劲；一处定不下来整轮弹回，
失败说明里又堆着候选、新行号和确认窗口。用户看了原话是「这个编辑的写法有点过于逆天了，为什么不能连续写呢」「这么写实在是太麻烦了」。

## Decision

- read、search 交回的窗口是一段连续的正文：`text` 加第一行的行号 `startLine`。换行一律是 `\n`；读到文件末尾时，文件结尾的换行照原样在，
  整份读出来原样写回去不多一行也不少一行。窗口不再带 `fileRef`（`velaros:files` 不再带 `version`）。
- edit 是一串按路径的步骤：`write` 把正文整份写进去（没有就新建），`replace` 把文件里唯一的一段原文 `oldText` 换成 `newText`；
  `velaros:project` 另有 `move`、`delete`、`recode`。同一个文件接连几步时，后一步按前一步改完的内容算；前面的步骤移走、删掉的路径，再写就是新建。
- 编辑作用在提交那一刻的内容上：`replace` 要换的原文还在就成，外部改了别处照样保住；原文没了（或不唯一）就整次不写，
  说明里给最像的几行或出现在第几行。`write` 是整份换掉，和 shell 的重定向一样不核对读过的版本，被换掉的内容由这次改动的撤销找回。
- 读取凭据还在，只是不经模型的手：`velaros:project` 的 edit 在写门里按路径整份读一次、自己取覆盖全文的 `fileRef`，
  再交给原来的编辑规划与事务；`velaros:files` 在内存里逐步改好底稿再整批落盘。计划之后、落盘之前文件被改过，照旧不覆盖。
- 改完过不了校验的说明收短：同一个文件的几处出错预览并成一段（重叠的行只出一次），诊断里不再重复写位置，
  预览只带前 3 条语法诊断、说明只列前 5 条。

## Alternatives

- **保留 `fileRef`，只把读出来的形状改成连续正文**：模型照样要抄凭据、数行号，麻烦的根子没动。否决。
- **write 可选带上读到的版本，对不上就拒**：又回到「先读、抄版本、再写」；一段程序里读完马上写，中间的空当极短，
  跨轮的外部改动由撤销兜底。和 ADR 0021「写入不按决策依据拦」一个取舍。否决。
- **模型写 unified diff**：上下文行要逐字对、行号要对，出错面比 `oldText` 更大。否决。

## Security and privacy

不碰权限与危险命令确认；路径照旧钳在项目根（或空间范围）内，越界的整次不写。

## Compatibility and migration

模型面换了形状（`baselines/script/project.d.ts`、`files.d.ts` 与两份代码模版已重新生成）：旧的 `fileRef`、`range` / `match` 编辑、
`create` / `overwrite` / `edit` 步骤、`version` 与 `edits` 都不再收，交进来报入参不对。宿主调用口 `projectFileOperations`、`fileOperations` 同步换形状；
Desktop 不读这两个结果的形状，不用改。project 的不变量 INV-2、INV-3 改写、INV-18 作废，files 的 INV-1、INV-3、INV-6、INV-7、INV-10、INV-12 改写，
逐条写在两份 `spec/invariants.md` 的说明里。ADR 0021 里「项目按文件版本核对」一句随之改成「按提交时的内容找原文」。

## Validation

两个单元的验收与单元测试按新形状重写（按路径写、接连几步、移走之后再写、外部改动之后 replace、CRLF 与混合换行、编码保留、读写往返字节不变）；
act 运行时与仓库层的模版测试里的程序换成新写法；两份代码模版照生成的声明过类型检查、在真空间里逐个函数跑一遍。

## Consequences

模型改文件就是「读出来的正文照抄一段当 `oldText`，写上 `newText`」或者「在程序里改好整份 `write`」，一段程序里可以连续写几步。
读完之后被外部改掉的内容，`write` 会整份盖掉（撤销能找回），`replace` 只在原文还在时生效。
