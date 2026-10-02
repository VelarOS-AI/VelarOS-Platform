import { AppError } from '@velaros-ai/core/error'

import type { ProjectSnapshotInput } from '../../types/observation.js'
import { snapshotInput } from '../../utils/agent/snapshot-input.js'

/** 领域固定计划目录；真实捕获只由当前会话的 Kernel 调用 project.snapshot。 */
export interface ProjectObservationProviderApi {
  /** Project 领域的固定目录身份。 */
  readonly id: 'project'
  /** 完整捕获经此已授权模块调用。 */
  readonly moduleId: 'velaros:project'
  /** Project 持有的固定捕获操作。 */
  readonly operation: 'snapshot'
  /** 固定纯派生的内容代次，不是资源变化代次。 */
  readonly revision: string
  /** Project 当前可发现的固定纯计划名。 */
  readonly plans: readonly string[]
  /** 只导入 output/input、只依赖实际捕获输入的包内程序。 */
  readonly source: string
  /** 按领域的真实输入合同核对目录计划。 */
  prepare(plan: string, input: unknown): ProjectSnapshotInput
}

export class ProjectObservationProvider implements ProjectObservationProviderApi {
  public readonly plans = ['files'] as const
  public readonly id = 'project'
  public readonly moduleId = 'velaros:project'
  public readonly operation = 'snapshot'
  public readonly revision = 'project-files-pure-snapshot-v1'
  public readonly source = `import { output } from 'velaros';
import { input } from 'velaros:program';
const { plan, capture } = input;
if (capture.files.length !== plan.files.length) throw new Error('Incomplete snapshot');
for (let index = 0; index < plan.files.length; index++) {
  const entry = plan.files[index];
  const file = capture.files[index];
  let value = file.text;
  if (entry.format === 'json') {
    value = JSON.parse(value);
    for (const encoded of (entry.pointer || '').split('/').slice(1)) {
      const part = encoded.replaceAll('~1', '/').replaceAll('~0', '~');
      if (value === null || typeof value !== 'object' || !Object.prototype.hasOwnProperty.call(value, part)) throw new Error('JSON Pointer is missing');
      value = value[part];
    }
  }
  output(value, { key: entry.key, purpose: entry.purpose, required: entry.required, view: { mode: entry.view || 'auto' } });
}`

  public prepare(plan: string, input: unknown): ProjectSnapshotInput {
    if (plan !== 'files') throw new AppError('NOT_FOUND', 'project 观察目录只有 files 纯快照计划')
    return snapshotInput(input)
  }
}

/** 标准领域目录不持有宿主读取端口；真实读取仍经已授权的领域操作与权威回执。 */
export function createProjectObservationProvider(): ProjectObservationProviderApi {
  return new ProjectObservationProvider()
}
