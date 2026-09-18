// velar:shell 的代码模版：一段一个函数、一种用法，挑要的照着改。
import { listTasks, refreshEnvironment, run } from 'velar:shell'

// 跑测试，只交出结论和失败现场的末尾。
async function runTests(cwd = '.') {
  const result = await run({ command: 'npm test', cwd, timeoutMs: 600000 })
  if (result.success) return { passed: true, ms: result.durationMs }
  return { passed: false, exitCode: result.exitCode, issues: result.verification.issues }
}

// 输出很长时在程序里筛，只交出要的那几行。
async function failingLines(cwd = '.') {
  const result = await run({ command: 'npm run lint', cwd, maxOutputChars: 50000 })
  const lines = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => /error/i.test(line))
  return { exitCode: result.exitCode, truncated: result.truncated, count: lines.length, last: lines.slice(-30) }
}

// 起开发服务器：长驻命令自动转后台，回执里有 taskId；按它查跑到哪了，停它用条目里的现成命令。
async function startServer(cwd = '.') {
  const started = await run({ command: 'npm run dev', cwd })
  const taskId = started.backgroundProcess?.taskId
  if (!taskId) return { started: false, exitCode: started.exitCode, stderr: started.stderr.slice(-2000) }
  const [task] = (await listTasks({ taskId })).tasks
  return { taskId, status: task?.status, output: task?.recentOutput?.slice(-1000), stop: task?.terminateCommand }
}

// 刚装完一个命令却还找不到：刷新一次环境再试。
async function afterInstall(command = 'rg --version') {
  await refreshEnvironment()
  const result = await run({ command })
  return result.success ? result.stdout.trim() : { missing: true, stderr: result.stderr.slice(-500) }
}
