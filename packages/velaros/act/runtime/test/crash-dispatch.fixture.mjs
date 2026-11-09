import { writeFile } from 'node:fs/promises'

import { localContextStorage } from '@velaros-ai/context/node'

import { createTestRuntime as createRuntime } from './support/runtime-fixture.mjs'
const storage = localContextStorage({ path: process.argv[2] })
const runtime = await createRuntime({
  storage,
  context: { maintenance: false, limits: { leaseMs: 500 } },
  modules: [
    {
      binding: { moduleId: 'test:crash', instanceId: 'one', generation: 1, schemaRevision: '1' },
      summary: 'crash after sending',
      operations: {
        send: {
          summary: 'write then crash',
          input: { type: 'null' },
          output: { type: 'null' },
          effects: 'write',
          run: async () => {
            await writeFile(process.argv[3], '1')
            process.exit(91)
          },
        },
      },
    },
  ],
})
const session = await runtime.openSession('crashed')
await session.context.append({ kind: 'user', body: 'Send exactly once' })
await session.execute({ source: "import {send} from 'test:crash';await send();" })
