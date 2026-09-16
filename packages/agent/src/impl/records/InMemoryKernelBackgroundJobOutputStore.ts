import type { KernelBackgroundJobOutputStore } from '../../contract/requires.js'
import type { KernelBackgroundJobStoredOutput } from '../../types/records.js'
import { normalizeReadOffset } from '../../utils/records/background-jobs'

class InMemoryKernelBackgroundJobOutputStore implements KernelBackgroundJobOutputStore {
  private readonly outputs = new Map<string, string>()
  private readonly sessionByJob = new Map<
    string,
    { sessionId: string; parentSessionId?: string }
  >()

  public append(input: {
    jobId: string
    sessionId: string
    parentSessionId?: string
    chunk: string
  }): void {
    const existing = this.outputs.get(input.jobId) ?? ''
    this.outputs.set(input.jobId, `${existing}${input.chunk}`)
    this.sessionByJob.set(input.jobId, {
      sessionId: input.sessionId,
      parentSessionId: input.parentSessionId,
    })
  }

  public read(input: { jobId: string; offset: number }): Nullable<KernelBackgroundJobStoredOutput> {
    if (!this.outputs.has(input.jobId)) return null

    const output = this.outputs.get(input.jobId) ?? ''

    const offset = normalizeReadOffset(input.offset, output.length)
    return {
      output: output.slice(offset),
      chars: output.length,
      nextOffset: output.length,
    }
  }

  public readAll(input: { jobId: string }): Nullable<KernelBackgroundJobStoredOutput> {
    return this.read({ jobId: input.jobId, offset: 0 })
  }

  public dropJob(jobId: string): void {
    this.outputs.delete(jobId)
    this.sessionByJob.delete(jobId)
  }

  public dropSession(sessionId: string): void {
    for (const [jobId, owner] of this.sessionByJob.entries()) {
      if (owner.sessionId !== sessionId && owner.parentSessionId !== sessionId) continue
      this.dropJob(jobId)
    }
  }
}

export { InMemoryKernelBackgroundJobOutputStore }
