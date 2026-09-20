import { writeFile } from 'node:fs/promises'
import { createContextRuntime, createContextView, createContextInvocationJournal } from '@velaros-ai/context'
import { localContextStorage } from '@velaros-ai/context/node'
import { createOperationRuntime } from '@velaros-ai/kernel'
const storage=localContextStorage({path:process.argv[2]})
const context=createContextRuntime({sessionId:'crashed',storage})
const view=createContextView({sessionId:'crashed',storage,context,sources:[],limits:{leaseMs:500}})
await view.begin((await context.append({kind:'user',body:'Send exactly once'})).ref)
await view.startStep('crash-step')
const runtime=createOperationRuntime({journal:createContextInvocationJournal(storage),modules:[{
  binding:{moduleId:'test:crash',instanceId:'one',generation:1,schemaRevision:'1'},summary:'crash after sending',
  operations:{send:{summary:'write then crash',input:{type:'null'},output:{type:'null'},effects:'write',run:async()=>{await writeFile(process.argv[3],'1');process.exit(91)}}},
}]})
await runtime.invoke({id:'external-write',sessionId:'crashed',executionId:'crash-step',binding:runtime.bind('crashed','test:crash'),operation:'send',input:null})
