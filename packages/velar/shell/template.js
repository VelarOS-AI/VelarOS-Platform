// velar:shell 的代码模版：一段一个函数、一种用法，挑要的照着改。
import { listTasks, refreshEnvironment, run, stop } from 'velar:shell'

// 跑测试：输出整份在手里，失败时只交出最后几十行。
async function runTests(cwd = '.') {
  const result = await run({ command: 'npm test', cwd, timeoutMs: 600000 })
  if (result.success) return { passed: true, ms: result.durationMs }
  const tail = `${result.stdout}\n${result.stderr}`.trim().split('\n').slice(-40)
  return { passed: false, exitCode: result.exitCode, timedOut: result.timedOut, tail }
}

// 输出很长时在程序里筛，只交出要的那几行。
async function errorLines(cwd = '.') {
  const result = await run({ command: 'npm run lint', cwd })
  const lines = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => /error/i.test(line))
  return { exitCode: result.exitCode, count: lines.length, first: lines.slice(0, 30) }
}

// 起开发服务器：长驻命令自动转后台，回执里有 taskId；listTasks 交回它到现在的全部输出。
async function startServer(cwd = '.') {
  const started = await run({ command: 'npm run dev', cwd })
  const taskId = started.backgroundProcess?.taskId
  if (!taskId) return { started: false, exitCode: started.exitCode, stderr: started.stderr.slice(-2000) }
  const [task] = (await listTasks({ taskId })).tasks
  return { taskId, status: task?.status, ports: started.backgroundProcess?.ports, lastLines: task?.output.split('\n').slice(-20) }
}

// 停掉后台任务：普通终止停不下来时会抛错，那就强杀。
async function stopServer(taskId = 'run 回执里的 taskId') {
  try {
    return await stop({ taskId })
  } catch {
    return stop({ taskId, force: true })
  }
}

// 刚装完一个命令却还找不到：刷新一次环境再试。
async function afterInstall(command = 'rg --version') {
  const { shells } = await refreshEnvironment()
  const result = await run({ command })
  return result.success ? result.stdout.trim() : { missing: true, shells: shells.map((shell) => shell.kind), stderr: result.stderr.slice(-500) }
}
