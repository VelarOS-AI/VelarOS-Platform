import {mkdir,mkdtemp,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'

import {runActEvaluation} from './act-eval.mjs'

export const evaluationScenarios=Object.freeze(['read-edit-observe','system-cooperation','semantic-search','reconciliation'])

// 同配置的独立运行逐个执行；保留失败分母和每次归档，不把缺失计量当零。
export async function runActEvaluationBatch(options,run=runActEvaluation){
 const {repeat=1,scenarios=evaluationScenarios,...configuration}=options
 if(!Number.isSafeInteger(repeat)||repeat<1||repeat>20||!Array.isArray(scenarios)||!scenarios.length||new Set(scenarios).size!==scenarios.length||scenarios.some(value=>!evaluationScenarios.includes(value)))throw Error('批量评测需要 1–20 次重复和有效、唯一的场景')
 await mkdir(resolve(configuration.output),{recursive:true})
 const output=await mkdtemp(join(resolve(configuration.output),'batch-'))
 const runs=[]
 for(const scenario of scenarios)for(let replicate=1;replicate<=repeat;replicate++){
  try{const result=await run({...configuration,output,scenario});runs.push({scenario,replicate,summary:result.summary})}
  catch(error){runs.push({scenario,replicate,error:error instanceof Error?error.message:String(error)})}
  await writeFile(join(output,'progress.json'),JSON.stringify({repeat,scenarios,runs},null,2))
 }
 const groups=scenarios.map(scenario=>{
  const attempts=runs.filter(run=>run.scenario===scenario),successful=attempts.filter(run=>run.summary?.passed).length
  const durations=attempts.map(run=>run.summary?.wallClockMs).filter(value=>typeof value==='number'&&Number.isFinite(value)).sort((a,b)=>a-b)
  const tokens=attempts.map(run=>run.summary?.totalUsage?.totalTokens)
  return {scenario,attempts:attempts.length,successful,successRate:successful/attempts.length,measuredDurations:durations.length,p50Ms:durations.length?durations[Math.ceil(durations.length*.5)-1]:null,p95Ms:durations.length?durations[Math.ceil(durations.length*.95)-1]:null,totalTokens:tokens.every(value=>typeof value==='number'&&Number.isFinite(value))?tokens.reduce((a,b)=>a+b,0):null}
 })
 const report={schema:'platform-act-eval-batch@1',output,repeat,passed:runs.every(run=>run.summary?.passed===true),groups,runs}
 await writeFile(join(output,'summary.json'),JSON.stringify(report,null,2))
 return report
}
