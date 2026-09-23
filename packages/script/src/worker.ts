/** 受信 worker 的独立运行环境入口，不加载编译器或父进程运行器。 */
export type { ScriptWorkerOptions } from './contract/requires.js'
export { startScriptWorker } from './impl/ScriptWorker.js'
export type { ScriptWorkerCommand, ScriptWorkerEvent } from './types/worker.js'
