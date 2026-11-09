import {
  openSessionControl,
  type RuntimeSessionBinding,
  type SessionControlLease,
  type SessionControlOptions,
} from '@velaros-ai/velaros'
import { localContextStorage } from '@velaros-ai/velaros/context/node'
import {
  resolveNodeRuntimeBinding,
  type NodeRuntimeBindingOptions,
} from '@velaros-ai/velaros/node'

declare const options: SessionControlOptions
declare const nodeOptions: NodeRuntimeBindingOptions
declare const control: SessionControlLease
const opened: Promise<SessionControlLease> = openSessionControl(options)
const binding: Promise<RuntimeSessionBinding> = resolveNodeRuntimeBinding(nodeOptions)
const note = control.readNote({ key: 'a', revision: 2, offset: 0, limit: 100 })
const page = control.listNotes({ after: 'a', limit: 5 })
const goal = control.getGoal()
const changed = control.controlGoal({ baseRevision: 1, action: 'pause' })
const closed: Promise<void> = control.close()
void [opened, binding, note, page, goal, changed, closed, localContextStorage]

// @ts-expect-error A storage-only lease cannot start model work.
control.submit('run')
// @ts-expect-error A storage-only lease cannot execute programs.
control.execute({ source: 'process.exit(0)' })
// @ts-expect-error Creating or replacing a goal still belongs to the formal Runtime.
control.updateGoal({ baseRevision: 0, objective: 'new task' })
// @ts-expect-error The existing goal CAS revision remains numeric.
control.controlGoal({ baseRevision: '1', action: 'pause' })
// @ts-expect-error Identity-only binding resolution does not take ownership of a Host.
resolveNodeRuntimeBinding({ ...nodeOptions, host: {} })
