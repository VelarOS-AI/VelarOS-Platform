// 显式本地发布的输入与 Git 身份门；不读取或改写 GitHub Actions 身份变量。

export function parseReleaseArguments(argv) {
  const options = { dryRun: false, skipBuild: false, localTag: undefined, onlySelectors: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--dry-run') options.dryRun = true
    else if (argument === '--skip-build') options.skipBuild = true
    else if (argument === '--local-tag' || argument === '--only') {
      const value = argv[++index]
      if (!value?.trim() || value.startsWith('--')) {
        throw new Error(`${argument} requires a value`)
      }
      if (argument === '--local-tag') {
        if (options.localTag !== undefined) throw new Error('--local-tag must be specified exactly once')
        if (value !== value.trim()) throw new Error('--local-tag must be an exact tag name')
        options.localTag = value
      } else {
        const selectors = value.split(',').map((entry) => entry.trim()).filter(Boolean)
        if (selectors.length === 0) throw new Error('--only requires at least one package name')
        options.onlySelectors.push(...selectors)
      }
    } else throw new Error(`Unknown release argument: ${argument}`)
  }
  if (options.localTag && options.dryRun) {
    throw new Error('--local-tag is a real publication mode; use --dry-run separately')
  }
  if (!options.dryRun && options.skipBuild) {
    throw new Error('--skip-build is a dry-run shortcut; a real publish must pack freshly built output')
  }
  return options
}

export function githubRepositoryIdentity(repository) {
  const input = typeof repository === 'string' ? repository : repository?.url
  if (typeof input !== 'string') throw new Error('Local publishing requires package.repository')
  const normalized = input.replace(/^git\+/u, '').replace(/^git@github\.com:/u, 'ssh://git@github.com/')
  let url
  try {
    url = new URL(normalized)
  } catch {
    throw new Error('Release repository must be an exact GitHub HTTPS or SSH repository URL')
  }
  if (
    url.hostname !== 'github.com'
    || !['https:', 'ssh:'].includes(url.protocol)
    || url.port || url.search || url.hash || url.password
    || (url.protocol === 'https:' && url.username)
    || (url.protocol === 'ssh:' && url.username !== 'git')
  ) throw new Error('Release repository must be an exact GitHub HTTPS or SSH repository URL')
  const match = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(url.pathname)
  if (!match || ['.', '..'].includes(match[2])) throw new Error('Release repository must name one GitHub repository')
  return `${match[1]}/${match[2]}`.toLowerCase()
}

/** runForOutput is injected so the complete identity gate can be tested without a network or credentials. */
export function assertLocalReleaseIdentity({ root, tag, repository, expectedSourceSha, runForOutput }) {
  const git = (args) => runForOutput('git', args, root)
  git(['check-ref-format', `refs/tags/${tag}`])
  const sourceSha = git(['rev-parse', 'HEAD'])
  if (!/^[a-f0-9]{40}$/u.test(sourceSha)) throw new Error('Local release HEAD must be a full commit SHA')
  if (expectedSourceSha && sourceSha !== expectedSourceSha) {
    throw new Error('Release source changed after validation')
  }
  if (git(['status', '--porcelain', '--untracked-files=all'])) {
    throw new Error('Local release artifacts require a clean working tree')
  }
  const repositoryIdentity = githubRepositoryIdentity(repository)
  if (githubRepositoryIdentity(git(['remote', 'get-url', 'origin'])) !== repositoryIdentity) {
    throw new Error('Release origin must match package.repository')
  }
  const ref = `refs/tags/${tag}`
  const localObject = git(['rev-parse', '--verify', ref])
  const localCommit = git(['rev-parse', '--verify', `${ref}^{commit}`])
  if (localCommit !== sourceSha) throw new Error('Local release tag must identify HEAD')
  const remoteRefs = new Map()
  for (const line of git(['ls-remote', '--exit-code', 'origin', ref, `${ref}^{}`]).split('\n')) {
    const match = /^([a-f0-9]{40})\s+(\S+)$/u.exec(line)
    if (!match || ![ref, `${ref}^{}`].includes(match[2]) || remoteRefs.has(match[2])) {
      throw new Error('Release remote returned an invalid or ambiguous tag identity')
    }
    remoteRefs.set(match[2], match[1])
  }
  const remoteObject = remoteRefs.get(ref)
  const remoteCommit = remoteRefs.get(`${ref}^{}`) ?? remoteObject
  if (!remoteObject || remoteObject !== localObject || remoteCommit !== sourceSha) {
    throw new Error('Release remote tag must exactly match the local tag and HEAD')
  }
  return { sourceSha, tag, repository: repositoryIdentity }
}

/** Local publication owns the same complete quality command used by the Actions workflow. */
export function runLocalReleaseChecks({ root, packageManager, assertIdentity, run, runForOutput }) {
  const expectedBunVersion = /^bun@(.+)$/u.exec(packageManager ?? '')?.[1]
  if (!expectedBunVersion || runForOutput('bun', ['--version'], root) !== expectedBunVersion) {
    throw new Error(`Local release requires the declared package manager ${packageManager}`)
  }
  assertIdentity()
  run('bun', ['install', '--frozen-lockfile'], root)
  assertIdentity()
  run('bun', ['run', 'check'], root)
  assertIdentity()
}
