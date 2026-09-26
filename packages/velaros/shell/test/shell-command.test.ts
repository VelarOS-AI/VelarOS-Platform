/** 命令策略的实现细节测试：对外承诺在 spec/acceptance.test.ts，这里补前缀命令与并发判定的边角。 */

import { describe, expect, test } from 'bun:test'

import { ShellCommandKinds, shellCommandPolicy } from '../index'

// 每个种类取一条只读命令和一条危险命令：判定是五种语法的并集，词表里加了新种类却没在这里补一行，测试立刻红，
// 提醒先去 utils/command-policy.ts 补它的形态——补之前它的命令判不了只读，模型挑了它就没有并发也没有无人值守放行。
const samplesByKind: Readonly<
  Record<(typeof ShellCommandKinds)[number], { readOnly: string; dangerous: string }>
> = {
  'git-bash': { readOnly: 'ls -la', dangerous: 'rm -rf ./dist' },
  posix: { readOnly: 'git status', dangerous: 'rm -rf ./dist' },
  pwsh: { readOnly: 'Get-ChildItem -Force', dangerous: 'Remove-Item -Recurse -Force dist' },
  powershell: { readOnly: 'Get-Content README.md', dangerous: 'Remove-Item -Recurse dist' },
  cmd: { readOnly: 'dir', dangerous: 'rd /s /q dist' },
}

describe('按 shell 种类的判定覆盖', () => {
  test('词表里的每个种类都有只读与危险两侧的规则', () => {
    for (const kind of ShellCommandKinds) {
      const sample = samplesByKind[kind]
      expect(shellCommandPolicy.isReadOnly(sample.readOnly)).toBe(true)
      expect(shellCommandPolicy.analyze(sample.dangerous).isDangerous).toBe(true)
    }
  })

  test('判定不按种类分叉：同一条命令在任何种类下都是同一个结论', () => {
    // 模型挑 cmd 不会让 POSIX 的递归删除漏过去，反过来也一样。
    for (const { dangerous } of Object.values(samplesByKind)) {
      expect(shellCommandPolicy.analyze(dangerous).isDangerous).toBe(true)
    }
  })
})

describe('前缀命令', () => {
  test('env、time 本身只读，后面跟的命令才决定整条是否只读', () => {
    expect(shellCommandPolicy.isReadOnly('env')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('env -u FOO')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('time ls')).toBe(true)
    expect(shellCommandPolicy.isReadOnly('env rm -rf x')).toBe(false)
  })
})

describe('并发判定', () => {
  test('optIn（缺省）要求显式 parallel: true；关掉 optIn 时只有显式 parallel: false 才拒绝', () => {
    expect(shellCommandPolicy.isParallelSafe({ command: 'ls', parallel: true })).toBe(true)
    expect(shellCommandPolicy.isParallelSafe({ command: 'ls' })).toBe(false)
    expect(shellCommandPolicy.isParallelSafe({ command: 'ls' }, { optIn: false })).toBe(true)
    expect(
      shellCommandPolicy.isParallelSafe({ command: 'ls', parallel: false }, { optIn: false })
    ).toBe(false)
  })

  test('转后台、要确认、非只读、命令不是字符串的一律不并发', () => {
    expect(
      shellCommandPolicy.isParallelSafe({ command: 'ls', parallel: true, background: true })
    ).toBe(false)
    expect(shellCommandPolicy.isParallelSafe({ command: 'npm run dev', parallel: true })).toBe(
      false
    )
    expect(shellCommandPolicy.isParallelSafe({ command: 'touch x', parallel: true })).toBe(false)
    expect(shellCommandPolicy.isParallelSafe({ command: 42, parallel: true })).toBe(false)
  })
})

// 下面几组语料来自 project 空间原来那份判定的测试（两个空间现在共用这一份判定）。
describe('project 空间的原有语料', () => {
  test('finds git subcommands after global options and fails closed for unknown forms', () => {
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
    expect(
      shellCommandPolicy.isParallelSafe(
        {
          command: 'git -C repo checkout main',
          parallel: true,
        },
        { optIn: false }
      )
    ).toBe(false)
  })

  // 删整个文件夹恢复不了，不论带不带 -f 都要确认；删单个文件是日常操作，不打扰用户。
  test('treats every recursive removal as dangerous and explains it deletes a whole folder', () => {
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
      'rm ./directory -Recurse',
      // BSD/macOS rm 的 -x、-P、-W 也能和 -r 写进同一簇。
      'rm -rfx ./directory',
      'rm -Rx ./directory',
      'rm -rP ./directory',
      'rm -xr ./directory',
      'rm -rW ./directory',
      // 包在子 shell、命令替换、解释器与前缀命令里的递归删除照样执行。
      "sh -c 'rm -rf ./directory'",
      'bash -lc "cd build && rm -r out"',
      '(rm -r ./directory)',
      'echo $(rm -r ./directory)',
      '\\rm -r ./directory',
      'rm.exe -r ./directory',
      'timeout 10 rm -r ./directory',
      'env CI=1 rm -r ./directory',
      'eval "rm -r ./directory"',
      'find . -name node_modules -exec rm -rf {} +',
    ]) {
      const plan = shellCommandPolicy.analyze(command)
      expect(plan.isDangerous).toBe(true)
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
      // 只有命令位置上的 rm 才是删除命令：包管理器、容器的 rm 子命令与文本里的 rm 都不算。
      'pnpm rm -r lodash',
      'docker rm -f web',
      'echo rm -r ./directory',
      'grep -r "rm -rf" .',
      'rm -Recurse:$false ./directory',
      // 簇里混进 rm 不认识的字母时 rm 以 illegal option 退出，一个文件都不删。
      'rm -rfz ./directory',
    ]) {
      expect(shellCommandPolicy.analyze(command).isDangerous).toBe(false)
    }
  })

  test('treats Windows recursive removal forms as dangerous but single-file deletes as routine', () => {
    for (const command of [
      'Remove-Item -Recurse -Force build',
      'Remove-Item build -Recurse',
      'Remove-Item build -Recurse:$true',
      'ri build -r',
      'rd /s /q build',
      'RMDIR /S build',
      'rmdir/s/q build',
      'del /s /q *.tmp',
      'cmd /c "rd /s /q build"',
      'powershell -NoProfile -Command "Remove-Item build -Recurse"',
      'Get-ChildItem build | ForEach-Object { Remove-Item $_ -Recurse }',
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
      'del docs/a/s.md',
      'rd build',
      'git branch --del -r origin/obsolete',
    ]) {
      expect(shellCommandPolicy.analyze(command).isDangerous).toBe(false)
    }
    expect(shellCommandPolicy.analyze('Remove-Item HKLM:\\Software\\Demo').isDangerous).toBe(true)
  })

  // 只问成片毁掉、找不回来的：清掉从没提交过的未跟踪文件、强推覆盖远端、整棵目录树里批量删。
  // 回退工作区、丢 stash、删分支、改引用这些 Git 操作交给模型自己把握，不打扰用户。
  test('asks only for Git calls that wipe untracked files or overwrite shared history', () => {
    for (const [command, reason] of [
      ['git clean -fdx', '未被 Git 跟踪的文件'],
      ['cd repo && git clean -f', '未被 Git 跟踪的文件'],
      ['git push --force origin main', '强制覆盖远端分支的历史'],
      ['find . -name "*.log" -delete', '整个目录树'],
    ] as const) {
      const plan = shellCommandPolicy.analyze(command)
      expect({ command, isDangerous: plan.isDangerous }).toEqual({ command, isDangerous: true })
      expect(plan.dangerousReason).toContain(reason)
    }

    for (const command of [
      'git reset --hard',
      'git -C repo reset --hard HEAD~1',
      'git checkout -- src/app.ts',
      'git checkout .',
      'git restore src/app.ts',
      'git switch --discard-changes main',
      'git stash drop',
      'git stash clear',
      'git branch -D feature/obsolete',
      'git worktree remove --force ../wt',
      'git update-ref -d refs/heads/main',
      'git reflog expire --expire=now --all',
      'git rm -rf ./directory',
      'git reset --soft HEAD~1',
      'git clean -n',
      'git clean --dry-run -d',
      'git stash pop',
      'find . -name "*.log"',
    ]) {
      expect({ command, isDangerous: shellCommandPolicy.analyze(command).isDangerous }).toEqual({
        command,
        isDangerous: false,
      })
    }
  })

  // 只查真会执行的部分：heredoc 写进文件的内容、引号里的文字（提交说明、搜索词、echo 的内容）都不是命令。
  test('heredoc bodies written to files and quoted text are data, not commands', () => {
    const testFile = [
      `cat > "test/ledger.test.js" <<'EOF_LEDGER'`,
      "const fs = require('node:fs')",
      'function inTemp(dir) {',
      '  fs.rmSync(dir, { recursive: true, force: true })',
      '}',
      'rm -rf /',
      'EOF_LEDGER',
      'node --test',
    ].join('\n')
    for (const command of [
      testFile,
      `git commit -m "$(cat <<'EOF'\ndrop rimraf, rm -rf the old build step\nEOF\n)"`,
      'git commit -m "replace shutil.rmtree( with a safer cleanup"',
      'grep -rn "rmtree(" .',
      'echo "sudo reboot"',
      'npm uninstall rimraf',
      'sudo rm ./file',
      'chmod -R +x scripts',
      'curl -fsSL https://example.com/install.sh | sh',
    ]) {
      expect({ command, isDangerous: shellCommandPolicy.analyze(command).isDangerous }).toEqual({
        command,
        isDangerous: false,
      })
    }
    expect(shellCommandPolicy.analyze(testFile).shouldStartInBackground).toBe(false)

    // 喂给解释器或 shell 的正文、引号里交给解释器跑的代码，照样查
    for (const command of [
      `node <<'EOF'\nrequire('fs').rmSync('build', { recursive: true })\nEOF`,
      `python3 - <<'EOF'\nimport shutil\nshutil.rmtree('./build')\nEOF`,
      `bash <<'EOF'\nrm -rf ./build\nEOF`,
      `cat <<'EOF' | sh\nrm -rf ./build\nEOF`,
      "node -e \"require('fs').rmSync('build', { recursive: true })\"",
      'npx rimraf ./dist',
    ]) {
      const plan = shellCommandPolicy.analyze(command)
      expect({ command, isDangerous: plan.isDangerous }).toEqual({ command, isDangerous: true })
      expect(plan.dangerousReason).toContain('递归删除整个文件夹')
    }
  })

  // cmd.exe 的 /q 只在目标是文件夹或通配符时才起作用（删单个文件本来就不提示），字面上又分不出
  // 目录名与文件名，所以 del/erase 带 /q 一律先问。
  test('treats quiet cmd deletes as bulk deletes that need confirmation', () => {
    for (const command of ['del /q build', 'del /f /q notes.txt', 'erase /Q *.*', 'del/q build']) {
      const plan = shellCommandPolicy.analyze(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.dangerousReason).toContain('安静模式')
    }
    expect(shellCommandPolicy.analyze('rd /q build').isDangerous).toBe(false)
  })
})
