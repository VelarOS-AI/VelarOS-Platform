import { executions } from 'velaros:system'

export default await executions.wait({ executionId: '执行回执中的 executionId', waitMs: 60000, cursor: 0 })
