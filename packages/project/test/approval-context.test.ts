import { resolve } from 'node:path'

import { describe, expect, test } from 'bun:test'

import { projectTools } from '../src/agent/Project.tool.js'
import {
  analyzeCommandExecution,
  isParallelCommandExecutionSafe,
  isShellCommandReadOnly,
} from '../src/command-execution-policy.js'
import { installProjectApprovalProvider } from '../src/composition/approval.js'

describe('project approval context', () => {
  test('finds git subcommands after global options and fails closed for unknown forms', () => {
    expect(isShellCommandReadOnly('git -C repo status')).toBe(true)
    expect(isShellCommandReadOnly('git -c core.fileMode=false log -1')).toBe(true)
    expect(isShellCommandReadOnly('git --git-dir repo/.git status')).toBe(true)
    expect(isShellCommandReadOnly('git --git-dir=repo/.git status')).toBe(true)
    expect(isShellCommandReadOnly('git -C --output=repo status')).toBe(true)
    expect(isShellCommandReadOnly('git -C repo checkout main')).toBe(false)
    expect(isShellCommandReadOnly('git --git-dir=repo/.git clean -fd')).toBe(false)
    expect(isShellCommandReadOnly('git branch -D obsolete')).toBe(false)
    expect(isShellCommandReadOnly('git config --set core.fileMode false')).toBe(false)
    expect(isShellCommandReadOnly('git diff --output=changes.patch')).toBe(false)
    expect(isShellCommandReadOnly('git log --output history.txt')).toBe(false)
    expect(isShellCommandReadOnly('git show --output=commit.txt HEAD')).toBe(false)
    expect(isShellCommandReadOnly('git --future-option status')).toBe(false)
    expect(isShellCommandReadOnly('git future-command')).toBe(false)
    expect(isShellCommandReadOnly('git -C')).toBe(false)
    expect(isParallelCommandExecutionSafe({
      command: 'git -C repo checkout main',
      parallel: true,
    })).toBe(false)
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
      'git rm -rf ./directory',
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
      const plan = analyzeCommandExecution(command)
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
      // 只有命令位置上的 rm 才是删除命令：包管理器、容器的 rm 子命令与文本里的 rm 都不算。
      'pnpm rm -r lodash',
      'docker rm -f web',
      'echo rm -r ./directory',
      'grep -r "rm -rf" .',
      'rm -Recurse:$false ./directory',
      // 簇里混进 rm 不认识的字母时 rm 以 illegal option 退出，一个文件都不删。
      'rm -rfz ./directory',
    ]) {
      expect(analyzeCommandExecution(command).isDangerous).toBe(false)
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
      const plan = analyzeCommandExecution(command)
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
      expect(analyzeCommandExecution(command).isDangerous).toBe(false)
    }
    expect(analyzeCommandExecution('Remove-Item HKLM:\\Software\\Demo').isDangerous).toBe(true)
  })

  // 与项目写入同一条线——能不能恢复：丢掉从没进过 Git 的工作区改动、未跟踪文件或 stash 的要先问；
  // 切分支、合并、只动索引的形态都能找回，照常执行。
  test('treats Git calls that discard uncommitted work as dangerous', () => {
    for (const [command, reason] of [
      ['git reset --hard', '未提交的改动会永久丢失'],
      ['git -C repo reset --hard HEAD~1', '未提交的改动会永久丢失'],
      ['git reset --merge ORIG_HEAD', '未提交的改动会永久丢失'],
      ['git checkout -- src/app.ts', '未提交的改动会永久丢失'],
      ['git checkout HEAD -- .', '未提交的改动会永久丢失'],
      ['git checkout .', '未提交的改动会永久丢失'],
      ['git checkout -f main', '未提交的改动会永久丢失'],
      ['git switch --discard-changes main', '未提交的改动会永久丢失'],
      ['git restore src/app.ts', '未提交的改动会永久丢失'],
      ['git restore --staged --worktree src/app.ts', '未提交的改动会永久丢失'],
      ['git clean -fdx', '未被 Git 跟踪的文件'],
      ['cd repo && git clean -f', '未被 Git 跟踪的文件'],
      ['git stash drop', 'stash'],
      ['git stash clear', 'stash'],
      ['find . -name "*.log" -delete', '整个目录树'],
    ] as const) {
      const plan = analyzeCommandExecution(command)
      expect({ command, isDangerous: plan.isDangerous }).toEqual({ command, isDangerous: true })
      expect(plan.dangerousReason).toContain(reason)
    }

    for (const command of [
      'git reset',
      'git reset --soft HEAD~1',
      'git reset -q HEAD -- src/app.ts',
      'git reset --keep HEAD~1',
      'git restore --staged src/app.ts',
      'git checkout main',
      'git checkout -b feature/x',
      'git switch main',
      'git clean -n',
      'git clean --dry-run -d',
      'git stash',
      'git stash pop',
      'git merge main',
      'git rebase main',
      'git rm -rf --cached build',
      'find . -name "*.log"',
    ]) {
      expect({ command, isDangerous: analyzeCommandExecution(command).isDangerous }).toEqual({ command, isDangerous: false })
    }
  })

  // cmd.exe 的 /q 只在目标是文件夹或通配符时才起作用（删单个文件本来就不提示），字面上又分不出
  // 目录名与文件名，所以 del/erase 带 /q 一律先问。
  test('treats quiet cmd deletes as bulk deletes that need confirmation', () => {
    for (const command of ['del /q build', 'del /f /q notes.txt', 'erase /Q *.*', 'del/q build']) {
      const plan = analyzeCommandExecution(command)
      expect(plan.isDangerous).toBe(true)
      expect(plan.dangerousReason).toContain('安静模式')
    }
    expect(analyzeCommandExecution('rd /q build').isDangerous).toBe(false)
  })

  test('dangerous project approval identifies the precise command and working directory', async () => {
    const workspaceRoot = resolve('/workspace')
    let seen: Record<string, unknown> | undefined
    const result = (await projectTools['project:run'].execute(
      { command: 'rm -rf ./dist' },
      {
        abortSignal: new AbortController().signal,
        approval: {
          awaitConfirmationDecision: async (
            _message: string,
            _signal?: AbortSignal,
            options?: Record<string, unknown>,
          ) => {
            seen = options
            return { approved: false, message: 'nope', autoApproved: false }
          },
        },
        system: { canStartBackgroundCommands: () => true },
        project: { getRootPath: () => workspaceRoot },
      } as never,
    )) as { approved: boolean }

    expect(seen).toMatchObject({
      approvalRisk: 'high',
      riskScope: 'project-command:dangerous',
      operation: { label: 'rm -rf ./dist', target: workspaceRoot },
    })
    expect(result.approved).toBe(false)
  })

  test('denies privileged approval when no host scope is active', async () => {
    const kernel: {
      providers: {
        approval?: {
          approve(input: {
            action: string
            risk: 'low' | 'medium' | 'high'
            reason: string
          }): Promise<boolean> | boolean
        }
      }
    } = { providers: {} }

    installProjectApprovalProvider(kernel)

    expect(
      await kernel.providers.approval?.approve({
        action: 'apply_edit',
        risk: 'high',
        reason: 'test',
      }),
    ).toBe(false)
  })
})
