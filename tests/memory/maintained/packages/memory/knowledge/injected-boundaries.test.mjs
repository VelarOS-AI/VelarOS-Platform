import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  EmbeddingApi,
  Embeddings,
  KnowledgeWorkspace,
} from '@velaros-ai/memory/knowledge'

test('embedding runtime is fully resolved by the injected host port', async () => {
  const requests = []
  const embeddings = new Embeddings(
    new EmbeddingApi({
      createEmbeddingRequest(config, model, texts) {
        requests.push({ config, model, texts })
        return {
          url: 'injected://embedding',
          headers: {},
          execute: async () => ({ embedding: [0.1, 0.2, 0.3] }),
        }
      },
    }),
    {
      resolveEmbeddingRuntime: () => ({
        provider: 'host-provider',
        model: 'host-embedding-model',
        apiKey: 'opaque',
        baseURL: 'injected://provider',
        configured: true,
      }),
      isManualEmbeddingAllowed: () => true,
    },
    {
      postJson: async () => {
        throw new Error('injected request should not use the HTTP fallback')
      },
    },
  )

  assert.deepEqual(await embeddings.embedText('hello'), [0.1, 0.2, 0.3])
  assert.deepEqual(requests, [{
    config: {
      provider: 'host-provider',
      apiKey: 'opaque',
      baseURL: 'injected://provider',
    },
    model: 'host-embedding-model',
    texts: ['hello'],
  }])
})

test('index visibility is host-injectable without depending on Workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-knowledge-policy-'))
  try {
    await mkdir(join(root, 'public'))
    await mkdir(join(root, 'private'))
    await writeFile(join(root, 'public', 'readme.md'), 'public knowledge')
    await writeFile(join(root, 'private', 'secret.md'), 'private knowledge')

    const workspace = new KnowledgeWorkspace(undefined, {
      shouldIncludeEntry: ({ relativePath }) =>
        !relativePath.startsWith('private'),
    })
    const files = await workspace.listDocumentFiles(root)
    assert.deepEqual(files.map((file) => file.path), ['public/readme.md'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('workspace ingestion rejects path hints outside its root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'velaros-knowledge-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'velaros-knowledge-outside-'))
  try {
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true')
    const workspace = new KnowledgeWorkspace()
    const candidates = await workspace.listCodeCandidates({
      workspaceRoot: root,
      pathHints: [join(outside, 'secret.ts')],
      symbolHints: [],
      limit: 5,
    })
    assert.deepEqual(candidates, [])
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})
