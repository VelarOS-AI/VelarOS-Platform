// velaros:shell 的代码模版：日常最常用的几种写法，一段一个函数。只是示例——按你的需要改写、只取其中几行都行，不必照着写。
// 用的时候把要的那段放进程序，调用它并把要看的导出去，比如 `export default await runTests()`。
import { listTasks, refreshEnvironment, run, stop } from 'velaros:shell'

// 跑测试：全部输出都在程序里，通过就报一声，失败时只交出最后几十行。命令自己失败不抛错，照 success 判。
async function runTests(command = 'npm test', cwd = '.') {
  const result = await run({ command, cwd, timeoutMs: 600000 })
  if (result.success) return `通过（${result.durationMs} ms）`
  const output = `${result.stdout}\n${result.stderr}`.trim().split('\n')
  return { exitCode: result.exitCode, timedOut: result.timedOut, tail: output.slice(-60).join('\n') }
}

// 构建、lint 的输出很长时在程序里筛：只交出带 error 的那些行。
async function errorLines(command = 'npm run build', cwd = '.') {
  const result = await run({ command, cwd })
  const errors = `${result.stdout}\n${result.stderr}`.split('\n').filter((line) => /error/i.test(line))
  return { success: result.success, count: errors.length, errors: errors.slice(0, 50) }
}

// 看 git 现在的样子：在哪个分支、改了哪些文件、最近几次提交。几条只读命令可以一起跑。
async function gitState(cwd = '.') {
  const [branch, status, log] = await Promise.all([
    run({ command: 'git branch --show-current', cwd }),
    run({ command: 'git status --short', cwd }),
    run({ command: 'git log --oneline -5', cwd }),
  ])
  return { branch: branch.stdout.trim(), changed: status.stdout.split('\n').filter(Boolean), recent: log.stdout.trim().split('\n').filter(Boolean) }
}

// 在代码里找东西：rg 一行一处「路径:行号:内容」，切开之后按文件数一数再交出去。没命中时 rg 退出码是 1，不算出错。
async function findTodos(path = '.') {
  const result = await run({ command: `rg -n -H --no-heading --color never 'TODO|FIXME' "${path}"` })
  if (result.exitCode === 1) return '没有'
  if (!result.success) throw new Error(result.stderr)
  const hits = result.stdout.trim().split('\n').map((line) => {
    const [file, lineNumber, ...rest] = line.split(':')
    return { file, line: Number(lineNumber), text: rest.join(':').trim() }
  })
  /** @type {Record<string, number>} */
  const perFile = {}
  for (const hit of hits) perFile[hit.file] = (perFile[hit.file] ?? 0) + 1
  return { total: hits.length, perFile, first: hits.slice(0, 20) }
}

// 起开发服务器：放后台跑，回执里有 taskId 和认出来的端口；等两秒再看它输出了什么。
async function startServer(command = 'npm run dev', cwd = '.') {
  const started = await run({ command, cwd, background: true })
  const taskId = started.backgroundProcess?.taskId
  if (!taskId) return { started: false, exitCode: started.exitCode, output: `${started.stdout}\n${started.stderr}`.trim().slice(-2000) }
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const [task] = (await listTasks({ taskId })).tasks
  return { taskId, ports: started.backgroundProcess?.ports, status: task?.status, lastLines: task?.output.trim().split('\n').slice(-20) }
}

// 看后台任务跑到哪了：output 是它到现在的全部输出，只交出最后几行。
async function taskOutput(taskId = 'run 回执里的 taskId', lines = 30) {
  const [task] = (await listTasks({ taskId })).tasks
  if (!task) return '没有这条任务'
  return { status: task.status, exitCode: task.exitCode, lastLines: task.output.trim().split('\n').slice(-lines) }
}

// 停掉后台任务：普通终止停不下来时会抛错，那就强杀。
async function stopTask(taskId = 'run 回执里的 taskId') {
  try {
    return await stop({ taskId })
  } catch {
    return stop({ taskId, force: true })
  }
}

// 刚装完一个命令却还找不到：刷新一次环境再跑；刷过还找不到就是没装上。
async function afterInstall(command = 'pnpm --version') {
  await refreshEnvironment()
  const result = await run({ command })
  return result.success ? result.stdout.trim() : { missing: true, stderr: result.stderr.trim().slice(-500) }
}
