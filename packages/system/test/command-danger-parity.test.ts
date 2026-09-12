import { describe, expect, test } from 'bun:test'

import { analyzeCommandExecution as analyzeProjectCommand } from '../../project/src/command-execution-policy'
import { analyzeCommandExecution as analyzeSystemCommand } from '../src/SystemCommandExecutionPolicy'

// system 与 project 两个空间各有一份命令危险判定（两包互不依赖），同一条命令在两边必须得到同一结论，
// 否则同一条删除命令会在一个空间里问用户、在另一个空间里静默执行。改任何一边的危险规则都要让这份
// 语料在两边同时通过。
const DangerousCommands = [
  'rm -r ./directory',
  'rm -R ./directory',
  'rm --recursive ./directory',
  'rm -r -f ./directory',
  'rm -rfx ./directory',
  'rm -Rx ./directory',
  'rm -rP ./directory',
  'RM -RF /',
  'rm ./directory -Recurse',
  'sudo -u root rm -r /tmp/cache',
  'ls | xargs rm -r',
  "sh -c 'rm -rf ./directory'",
  '(rm -r ./directory)',
  'echo $(rm -r ./directory)',
  '\\rm -r ./directory',
  'find . -name node_modules -exec rm -rf {} +',
  'git rm -rf ./directory',
  'Remove-Item build -Recurse',
  'ri build -r',
  'rd /s /q build',
  'rmdir/s/q build',
  'cmd /c "rd /s /q build"',
  'del /q build',
  'Remove-Item HKLM:\\Software\\Demo',
  'git reset --hard',
  'git checkout -- src/app.ts',
  'git restore src/app.ts',
  'git clean -fdx',
  'git stash drop',
  'find . -name "*.log" -delete',
  'mkfs.ext4 /dev/sda',
  'sudo rm ./file',
]

const RoutineCommands = [
  'rm ./file',
  'rm -f ./file',
  'rm ./file -Force',
  'rm -rfz ./directory',
  'git rm -r ./directory',
  'pnpm rm -r lodash',
  'echo rm -r ./directory',
  'Remove-Item .\\notes.txt -Force',
  'del /f notes.txt',
  'del docs/a/s.md',
  'rd build',
  'git branch --del -r origin/obsolete',
  'git reset --soft HEAD~1',
  'git restore --staged src/app.ts',
  'git checkout main',
  'git clean -n',
]

describe('command danger parity between system and project spaces', () => {
  test('both spaces flag the same dangerous commands with the same reason', () => {
    for (const command of DangerousCommands) {
      const project = analyzeProjectCommand(command)
      const system = analyzeSystemCommand(command)
      expect({ command, isDangerous: system.isDangerous }).toEqual({ command, isDangerous: true })
      expect({ command, reason: system.dangerousReason }).toEqual({ command, reason: project.dangerousReason })
      expect(project.isDangerous).toBe(true)
    }
  })

  test('both spaces leave the same routine commands alone', () => {
    for (const command of RoutineCommands) {
      expect({ command, project: analyzeProjectCommand(command).isDangerous, system: analyzeSystemCommand(command).isDangerous })
        .toEqual({ command, project: false, system: false })
    }
  })
})
