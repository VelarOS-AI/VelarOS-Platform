import { isEmpty, isPresent } from '@velaros-ai/core'

import type { ProjectRuntimeProviders } from '../types/kernel.js'

/** `git … -z` 的路径输出：每条以 NUL 结尾，切开后去掉末尾空段。 */
function splitNulTerminatedPaths(output: string): string[] {
  return output.split('\0').filter(Boolean)
}
const IntentToAddProbeArgs = [
  'diff',
  '--cached',
  '--name-only',
  '-z',
  '--relative',
  '--no-renames',
] as const
interface ProjectGitIndexDependencies {
  readonly root: string
  readonly providers: Pick<ProjectRuntimeProviders, 'command' | 'logger'>
}
export class ProjectGitIndex {
  private gitWorkTreeCache?: boolean
  constructor(private readonly dependencies: ProjectGitIndexDependencies) {}

  private async runGit(args: string[], timeoutMs = 10_000) {
    return this.dependencies.providers.command.run({
      command: 'git',
      args,
      cwd: this.dependencies.root,
      timeoutMs,
    })
  }

  /**
   * 对内核给出的具体文件路径跑 git 子命令。`--literal-pathspecs` 让路径只按字面匹配：否则名为
   * `[s]taged.txt` 的文件会被当成 glob，连带命中用户真实暂存的 `staged.txt`，`git rm --cached`
   * 就把它一起移出索引。
   */
  private async runGitOnPaths(args: readonly string[], paths: readonly string[]) {
    return this.runGit(['--literal-pathspecs', ...args, '--', ...paths])
  }

  private async isInsideGitWorkTree(): Promise<boolean> {
    // 工作区根目录的 git 仓库归属在会话内是恒定的；缓存结果避免每次 apply/rollback 都新起 git 子进程。
    if (isPresent(this.gitWorkTreeCache)) return this.gitWorkTreeCache
    const result = await this.runGit(['rev-parse', '--is-inside-work-tree'], 5_000)
    this.gitWorkTreeCache = result.exitCode === 0 && result.stdout.trim() === 'true'
    return this.gitWorkTreeCache
  }

  public async trackCreatedFilesInGit(paths: string[]): Promise<string[]> {
    const files = [...new Set(paths)].filter(Boolean)
    if (isEmpty(files) || !(await this.isInsideGitWorkTree())) return []
    // intent-to-add 让新建文件进入 git diff 视野，但不会暂存文件内容。
    const result = await this.runGitOnPaths(['add', '--intent-to-add'], files)
    if (result.exitCode === 0) return files
    this.dependencies.providers.logger?.warn?.('project.git.trackCreatedFiles.failed', {
      files,
      stderr: result.stderr,
    })
    return []
  }

  public async untrackCreatedFilesFromGit(paths: string[]): Promise<string[]> {
    const files = [...new Set(paths)].filter(Boolean)
    if (isEmpty(files) || !(await this.isInsideGitWorkTree())) return []
    const result = await this.runGitOnPaths(['rm', '--cached', '--ignore-unmatch'], files)
    if (result.exitCode === 0) return files
    this.dependencies.providers.logger?.warn?.('project.git.untrackCreatedFiles.failed', {
      files,
      stderr: result.stderr,
    })
    return []
  }

  /**
   * 被删路径在索引里若只剩 intent-to-add 条目，就把条目撤掉，否则 `git status` 会留下一条删除残留。
   * 带真实内容的索引项（用户 `git add` 过的、已提交的）一律不动：索引照旧，删除留在工作区等用户处理。
   */
  public async untrackDeletedIntentToAddFromGit(paths: string[]): Promise<string[]> {
    const files = [...new Set(paths)].filter(Boolean)
    if (isEmpty(files) || !(await this.isInsideGitWorkTree())) return []
    const intentToAddFiles = await this.listIntentToAddFiles(files)
    if (isEmpty(intentToAddFiles)) return []
    const result = await this.runGitOnPaths(
      ['rm', '--cached', '--ignore-unmatch'],
      intentToAddFiles,
    )
    if (result.exitCode === 0) return intentToAddFiles
    this.dependencies.providers.logger?.warn?.('project.git.untrackDeletedIntentToAdd.failed', {
      files: intentToAddFiles,
      stderr: result.stderr,
    })
    return []
  }

  /**
   * 从 files 里挑出索引中是 intent-to-add（`git add -N`）的条目。
   *
   * 判据：diff-options 文档规定 `--ita-invisible-in-index` 把 intent-to-add 条目当作索引里不存在，
   * `--ita-visible-in-index` 把它当作空文件；两个开关只改变这一类条目的呈现，所以同一组路径在两种
   * 视图下 `diff --cached` 结果的差集恰好是 intent-to-add 条目。真实暂存的新文件（含空文件）两种
   * 视图都显示为新增；已提交且未改动的文件两种视图都不显示——只看「在索引里、但 `diff --cached` 不
   * 显示」会把后者误判成 intent-to-add，撤掉它等于替用户暂存了一次删除。
   *
   * 两个开关都显式给出、不赌默认值：文档写默认可见，porcelain `git diff` 实测默认不可见（git 2.54）。
   * 开关被文档标注为实验性；将来若被移除，git 以未知参数失败，这里只记告警、返回空——失败方向永远
   * 是留下残留，而不是误动真实暂存。
   */
  public async listIntentToAddFiles(files: readonly string[]): Promise<string[]> {
    const [visible, invisible] = await Promise.all([
      this.runGitOnPaths([...IntentToAddProbeArgs, '--ita-visible-in-index'], files),
      this.runGitOnPaths([...IntentToAddProbeArgs, '--ita-invisible-in-index'], files),
    ])
    if (visible.exitCode !== 0 || invisible.exitCode !== 0) {
      this.dependencies.providers.logger?.warn?.('project.git.listIntentToAdd.failed', {
        files,
        stderr: [visible.stderr, invisible.stderr].filter(Boolean).join('\n'),
      })
      return []
    }
    const shownWhenVisible = new Set(splitNulTerminatedPaths(visible.stdout))
    const shownWhenInvisible = new Set(splitNulTerminatedPaths(invisible.stdout))
    return files.filter((file) => shownWhenVisible.has(file) && !shownWhenInvisible.has(file))
  }
}
