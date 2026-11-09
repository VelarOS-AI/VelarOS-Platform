import {
  openSessionControl,
  type ActTracePage,
  type ActTraceQuery,
  type SessionControlLease,
  type SessionControlOptions,
} from '@velaros-ai/velaros'

// The isolated consumer compiles this file with strict:true and skipLibCheck:false.
declare const options: SessionControlOptions
declare const control: SessionControlLease
const query: ActTraceQuery = { after: 0, limit: 1, activityAfter: 0, activityLimit: 1, maxChars: 256 }
const opened: Promise<SessionControlLease> = openSessionControl(options)
const defaultPage: Promise<ActTracePage> = control.trace()
const page: Promise<ActTracePage> = control.trace(query)
const fullPage: Promise<ActTracePage> = control.trace({ sessionId: 'owned-branch', fullContent: true })
const branches: Promise<ActTracePage['branches']> = control.traceBranches()
const close: Promise<void> = control.close()
void [opened, defaultPage, page, fullPage, branches, close]

// @ts-expect-error A storage-only trace lease cannot execute a program.
control.execute({ source: 'console.log(1)' })
// @ts-expect-error A storage-only trace lease cannot start model work.
control.submit('run')
// @ts-expect-error Trace paging cursors remain numeric.
control.trace({ after: '1' })
// @ts-expect-error Trace queries do not accept executable callbacks.
control.trace({ execute: () => null })
