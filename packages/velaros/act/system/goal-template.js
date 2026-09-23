import {output} from 'velaros';
import {goal} from 'velaros:system';
const {get, update} = goal;
const current = await get();
output(current);
// 只在用户要求持续推进一个目标时建立；objective 是用户授权的具体工作。
// await update({baseRevision: current?.revision ?? 0, objective: '用户要求的目标'});
// 有实际验收结果后，先重新读取版本再显式完成。
// await update({baseRevision: current.revision, status: 'complete', reason: '实际验收依据'});
// 用户要求暂停才暂停；结束一轮回复和停止执行都不代表目标已完成。
