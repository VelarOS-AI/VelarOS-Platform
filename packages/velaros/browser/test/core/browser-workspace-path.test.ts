// 用途：钉住站点工作区只有一套包含判定，而且判的是真实路径。
// 历史事故：engine 落盘与上传走的 resolveWorkspaceFilePath 只做字面 path.resolve，
// 工作区里只要有一个指向外面的符号链接（用户或别的空间建的），fetch_resource / handle_download /
// 截图就能写到工作区外，upload_file 能把链接指向的任意文件（例如私钥）传给网页；
// 而同一个链接在 browser:files 那套判定里是拒绝的。
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, test } from 'bun:test'

import { createBrowserSiteWorkspaceFileAccess } from '../../impl/workspace/BrowserWorkspaceFileAccess.js'
import { resolveWorkspaceFilePath } from '../../utils/workspace-paths.js'

/** 造一个站点工作区：downloads/ 是指向工作区外目录的符号链接，leak.txt 是指向区外文件的链接。 */
async function createLinkedSiteRoot(): Promise<{ siteRoot: string; outside: string }> {
  const base = await mkdtemp(join(tmpdir(), 'velaros-browser-path-'))
  const siteRoot = join(base, 'browser-sites', 'example-com')
  const outside = join(base, 'outside')
  await mkdir(siteRoot, { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(outside, 'secret.pem'), 'PRIVATE KEY', 'utf8')
  await symlink(outside, join(siteRoot, 'downloads'))
  await symlink(join(outside, 'secret.pem'), join(siteRoot, 'leak.pem'))
  return { siteRoot, outside }
}

void describe('站点工作区的路径包含判定', () => {
  void test('落盘路径穿过符号链接出界时拒绝', async () => {
    const { siteRoot } = await createLinkedSiteRoot()

    await assert.rejects(
      resolveWorkspaceFilePath(siteRoot, 'downloads/payload.bin', 'savePath'),
      /不能离开当前站点工作区/u
    )
  })

  void test('上传路径本身是指向区外文件的符号链接时拒绝', async () => {
    const { siteRoot } = await createLinkedSiteRoot()

    await assert.rejects(
      resolveWorkspaceFilePath(siteRoot, 'leak.pem', 'filePath'),
      /不能离开当前站点工作区/u
    )
  })

  void test('browser:files 与 engine 落盘对同一个链接给同一个判定', async () => {
    const { siteRoot } = await createLinkedSiteRoot()
    const access = createBrowserSiteWorkspaceFileAccess({
      url: 'https://example.test/',
      workspaceRoot: siteRoot,
    } as never)

    await assert.rejects(
      access.writeFile('downloads/probe.txt', 'x', { overwrite: true }),
      /不能离开当前站点/u
    )
    await assert.rejects(
      resolveWorkspaceFilePath(siteRoot, 'downloads/probe.txt', 'savePath'),
      /不能离开当前站点/u
    )
  })

  void test('工作区内的普通相对路径照常解析，相对路径用 / 连接', async () => {
    const { siteRoot } = await createLinkedSiteRoot()

    const resolved = await resolveWorkspaceFilePath(
      siteRoot,
      'artifacts/exports/page.pdf',
      'savePath'
    )
    assert.equal(resolved.relativePath, 'artifacts/exports/page.pdf')
    assert.ok(resolved.path.endsWith(join('artifacts', 'exports', 'page.pdf')))
  })

  void test('.. 穿越与绝对路径都拒绝', async () => {
    const { siteRoot } = await createLinkedSiteRoot()

    await assert.rejects(
      resolveWorkspaceFilePath(siteRoot, '../outside/payload.bin', 'savePath'),
      /不能离开当前站点工作区/u
    )
    await assert.rejects(
      resolveWorkspaceFilePath(siteRoot, '/etc/hosts', 'savePath'),
      /必须是当前站点工作区内的相对路径/u
    )
    await assert.rejects(resolveWorkspaceFilePath(siteRoot, '   ', 'savePath'), /不能为空/u)
  })
})
