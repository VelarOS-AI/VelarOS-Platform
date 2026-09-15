/**
 * 命令语义的验收测试：每一条对应 spec/invariants.md 里的一个编号。
 * 这里只测对外承诺的行为，不测实现细节；实现细节的测试在 test/ 目录。
 */

import { describe, expect, test } from 'bun:test'

import { shellCommandApproval, ShellCommandOperationKind, shellCommandPolicy } from '../src/exports/index'

describe('只读与危险判定', () => {
  test('INV-1 白名单命令一旦带写盘参数，整条掉出只读', () => {
    expect(shellCommandPolicy.isReadOnly('find . -name "*.ts"')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('sed -n 1,20p file.txt')).toBe(true)
    // 白名单是「无人值守自动放行」与「可并发执行」两道判定的底；这几种写盘形态必须掉出来。
    expect(shellCommandPolicy.isReadOnly('find . -name "*.tmp" -delete')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('find . -type f -exec rm {} ;')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('sed -i s/a/b/ file.txt')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('sed --in-place=.bak s/a/b/ file.txt')).toBe(false)
  })

  test('INV-1 git 全局选项能让只读子命令执行别的程序，一律判非只读；tree -o 写盘', () => {
    expect(shellCommandPolicy.isReadOnly("git -c core.pager='rm -rf x' log")).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git -c diff.external=/tmp/evil diff')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git -ccore.fsmonitor=/tmp/evil.sh status')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --config-env=core.pager=EVIL log')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --exec-path=/tmp/evil status')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git -p log')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --paginate log')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --no-pager log -1')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('tree -o out.txt')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('tree -H . -o report.html')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('tree -L 2')).toBe(true)
  })

  test('INV-1 git 只认全局选项之后的已知只读子命令，未知形态一律判非只读', () => {
    expect(shellCommandPolicy.isReadOnly('git -C repo status')).toBe(true)
    // 任何 -c 都不算只读：值可能就是要执行的程序，判据不区分 key。
    expect(shellCommandPolicy.isReadOnly('git -c core.fileMode=false log -1')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --git-dir repo/.git status')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('git --git-dir=repo/.git status')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('git -C --output=repo status')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('git -C repo checkout main')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --git-dir=repo/.git clean -fd')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git branch -D obsolete')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git config --set core.fileMode false')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git diff --output=changes.patch')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git log --output history.txt')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git show --output=commit.txt HEAD')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git --future-option status')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git future-command')).toBe(false)
    expect(shellCommandPolicy.isReadOnly('git -C')).toBe(false)
  })

  // 这些写法都在本机实测过会执行别的程序或写文件（rg --pre rm 把搜到的文件全删了），却曾被判成只读、可并发、可无人值守放行。
  test('INV-1 参数、前缀和环境变量能让白名单命令执行别的程序或写文件，一律判非只读', () => {
    for (const command of [
      'rg --pre rm foo .',
      'rg --hostname-bin=touch foo .',
      'git grep -Otouch foo',
      'git grep --open-files-in-pager=touch foo',
      "git ls-remote --upload-pack='touch x' .",
      "git -C . ls-remote -u 'touch x' .",
      "git ls-remote --exec='touch x' .",
      "env -S'rm -rf x'",
      "env --split-string='rm -rf x'",
      "env -S'rm -rf x' cat file",
      'env time -o /tmp/out cat /etc/hosts',
      'time --output=/tmp/out cat file',
      'LD_PRELOAD=/tmp/evil.so cat file',
      "GIT_EXTERNAL_DIFF='rm -rf x' git diff",
      'env GIT_EXTERNAL_DIFF=x git diff',
      'RIPGREP_CONFIG_PATH=/tmp/rgrc rg foo',
      "sed -n '1w /tmp/out' file",
      "sed 's/a/b/gw /tmp/out' file",
      "sed -e'w /tmp/out' file",
      "sed --expression='w /tmp/out' file",
      "sed 's/.*/touch x/e' file",
      "sed '1e touch x' file",
      'sed -f script.sed file',
      // 方括号里的分隔符各家 sed 切法不一样，认不准就按会写处理。
      "sed 's/[/x/w out]/y/' file",
      'tree -R -H . -L 1',
      'tree -ao out.txt',
    ]) {
      expect({ command, readOnly: shellCommandPolicy.isReadOnly(command) }).toEqual({ command, readOnly: false })
    }
    // 只读的 sed 写法照样判只读，不因为收紧而全部掉出去。
    for (const command of ["sed -n '/start/,/end/p' notes.txt", "sed -E 's/[0-9]+/N/g' notes.txt", "sed '/x/!d' notes.txt", 'sed -n -e 2p -e 4p notes.txt', 'rg -n TODO src', 'git grep -n TODO', 'time -p ls']) {
      expect({ command, readOnly: shellCommandPolicy.isReadOnly(command) }).toEqual({ command, readOnly: true })
    }
  })

  // 删整个文件夹恢复不了，不论带不带 -f 都要确认；删单个文件是日常操作，不打扰用户。
  test('INV-2 递归删除一律判危险并说明删的是整个文件夹，删单个文件不打扰', () => {
    for (const command of [
      'rm -r ./directory',
      'rm -R ./directory',
      'rm --recursive ./directory',
      'rm --rec ./directory',
      'rm -r -f ./victim',
      'rm -f -r ./victim',
      'rm --recursive --force ./victim',
      'rm -r --force ./victim',
      'RM -RF /',
      '/bin/RM -Rf /',
      'RM --RECURSIVE --FORCE /',
      'sudo rm -r /tmp/cache',
      'ls | xargs rm -r',
      'git rm -rf ./directory',
      'rm ./directory -Recurse',
    ]) {
      const plan = shellCommandPolicy.analyze(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.shouldRequestConfirmation).toBe(true)
      expect(plan.dangerousReason).toContain('递归删除整个文件夹')
    }

    for (const command of [
      'rm ./file',
      'rm -f ./file',
      'rm -v src/f.ts',
      'rm docs/s.md',
      'rm ./file -Force',
      'git rm -r --cached ./directory',
      'git rm -r ./directory',
    ]) {
      expect(shellCommandPolicy.analyze(command).isDangerous).toBe(false)
    }
  })

  test('INV-2 Windows 的递归删除形态同样判危险，单文件删除是日常操作', () => {
    for (const command of [
      'Remove-Item -Recurse -Force build',
      'Remove-Item build -Recurse',
      'Remove-Item build -Recurse:$true',
      'ri build -r',
      'rd /s /q build',
      'RMDIR /S build',
      'rmdir/s/q build',
      'del /s /q *.tmp',
    ]) {
      const plan = shellCommandPolicy.analyze(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.dangerousReason).toContain('递归删除整个文件夹')
    }

    for (const command of [
      'Remove-Item .\\notes.txt',
      'Remove-Item .\\notes.txt -Force',
      'del /f notes.txt',
      'del docs/s.md',
      'rd build',
      'git branch --del -r origin/obsolete',
    ]) {
      expect(shellCommandPolicy.analyze(command).isDangerous).toBe(false)
    }
    expect(shellCommandPolicy.analyze('Remove-Item HKLM:\\Software\\Demo').isDangerous).toBe(true)
  })

})

describe('危险命令的审批请求', () => {
  test('INV-3 高风险、必须用户亲自点、不可记忆；操作身份只看去掉首尾空白的命令、工作目录和前后台，跨工具一致', () => {
    const plan = shellCommandPolicy.analyze('rm -rf ./dist')
    const first = shellCommandApproval.dangerous({ command: 'rm -rf ./dist', plan, cwd: '/repo', background: false, scopeLabel: '当前项目', riskScope: 'project-command:dangerous' })
    const second = shellCommandApproval.dangerous({ command: '  rm -rf ./dist  ', plan, cwd: '/repo', background: false, scopeLabel: '系统运行环境', riskScope: 'system-command:dangerous' })
    expect(first.options).toMatchObject({ approvalRisk: 'high', requireManualApproval: true, rememberRiskScope: false, riskScope: 'project-command:dangerous', operation: { label: 'rm -rf ./dist', target: '/repo' } })
    expect(first.options.operation?.key.startsWith(`${ShellCommandOperationKind}:`)).toBe(true)
    expect(second.options.operation?.key).toBe(first.options.operation?.key)
    expect(shellCommandApproval.dangerous({ command: 'rm -rf ./dist', plan, cwd: '/other', background: false, scopeLabel: '当前项目', riskScope: 'x' }).options.operation?.key).not.toBe(first.options.operation?.key)
    expect(shellCommandApproval.dangerous({ command: 'rm -rf ./dist', plan, cwd: '/repo', background: true, scopeLabel: '当前项目', riskScope: 'x' }).options.operation?.key).not.toBe(first.options.operation?.key)
    // 文案写明命令、理由，递归删除时提醒仓库里的未推送提交会一起没掉。
    expect(first.message).toContain('rm -rf ./dist')
    expect(first.message).toContain('递归删除整个文件夹')
    expect(first.message).toContain('未推送的提交')
  })
})
