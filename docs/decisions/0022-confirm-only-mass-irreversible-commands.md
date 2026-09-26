# 0022: 命令确认只留成片毁掉、找不回来的

- Status: accepted
- Date: 2026-09-26
- Owners: `@velaros-ai/velaros`（shell 单元的命令判定，沙箱与项目空间共用）

## Context

长任务真跑时，模型用 `cat > test/ledger.test.js <<'EOF' … EOF` 写测试文件，却弹了一张「高风险命令」确认卡，卡上把整段文件内容都摊了出来。
判定拿正则扫整条命令文本：heredoc 里要写进文件的测试代码有一句清理临时目录的 `fs.rmSync(dir, { recursive: true })`，就被当成递归删除；
引号里的文字同样会误中（`git commit -m "去掉 rimraf"`、`grep "rmtree("`、`echo "sudo reboot"`）。
用户的裁决：「为什么 cat 也需要批准」「尽量减少需要用户批准的操作」「给予模型最大的信任」，卡片「一个标题就行」。

## Decision

- 只查真会执行的部分：heredoc 按喂给谁分——`cat`、`tee` 这类只把正文当数据的，正文不查；喂给 node、python 这类解释器的按代码查；
  喂给 shell、认不出的命令或接了管道的，按命令递归判定。引号里的文字不当命令查，除非命令里有 `bash -c`、`node -e` 这类把它当代码跑的调用。
- 要确认的只剩成片毁掉、找不回来的：递归/批量删除（`rm -r`、`rd /s`、`Remove-Item -Recurse`、`find -delete`、`del /q`、代码里的
  rmtree/rimraf/递归 rmSync）、清掉未跟踪文件（`git clean`）、强推覆盖远端（`git push --force`）、抹盘格式化与关机这类整机破坏。
  Git 回退（reset --hard、checkout/restore、stash drop、branch -D、update-ref、reflog expire、filter-branch、git rm）、提权
  （sudo、chmod -R、chown -R、runas、icacls）、下载脚本直接执行（curl | sh）交给模型自己把握。
- 确认文案只有一行：在哪、哪一类、命令第一行（太长截断），如「在当前项目递归删除：rm -rf dist」。卡片等回答时只显示这一行，
  回答过之后点开能回看命令全文。
- Desktop 设置里的「从不询问」档真的不问：危险命令也直接放行（登录墙照常，要用户自己去登录）。

## Alternatives

- **按路径放行递归删除**（目标在项目根之内就不问）：要解析工作目录、变量、通配、命令里的 `cd`，判错一次就是 9 月 15 日那种整仓误删。暂不做。
- **全部不问**：只对「从不询问」档这样做，默认档保留最后这一小类。

## Security and privacy

ADR 0009 的判据不变：能被 shell 绕过的确认只是摩擦。留下的都是模型手滑就会成片毁掉数据、事后找不回来的。

## Compatibility and migration

确认文案从多行说明变成一行标题；判定少了 Git 回退、提权、远程脚本三类。宿主不用改。

## Validation

shell INV-2、INV-3 按新口径改写；`test/shell-command.test.ts` 加 heredoc 与引号用例（写文件的正文、提交说明、搜索词不算，喂给解释器的照查），
`test/corpus.test.ts` 把 Git 回退、提权、远程脚本挪进日常命令。

## Consequences

模型写文件、提交、搜索、回退自己的改动都不再被打断；用户只在删整个目录、清未跟踪文件、强推、抹盘时被问一句，而且只看到一行。
