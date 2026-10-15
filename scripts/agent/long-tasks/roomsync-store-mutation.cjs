'use strict'
// 只在独占评测子进程中替换实际提交内容；生产者原始对象和成功回执身份保持原样。
const fs = require('node:fs')
const path = require('node:path')
const api = require(path.join(process.env.VELAR_EVAL_PROJECT, 'contrib/roomsync/index.js'))
const { applyPatch } = require(
  path.join(process.env.VELAR_EVAL_PROJECT, 'contrib/roomsync/lib/patch.js')
)
const openStore = api.openStore
const changes = new Map()
function wrong(value) {
  if (value === null) return false
  if (typeof value === 'boolean') return !value
  if (typeof value === 'number') return value === 0 ? 1 : -value
  if (typeof value === 'string') return value + '\u2603'
  if (Array.isArray(value)) return value.concat(null)
  const result = { ...value }
  let key = '__injected_corruption__'
  while (Object.hasOwn(result, key)) key += '_'
  result[key] = true
  return result
}
api.openStore = async (...args) => {
  const store = await openStore(...args)
  const transact = store.transact.bind(store)
  store.transact = async (room, transaction, ...options) => {
    const identity = JSON.stringify([
      path.resolve(args[0]),
      room,
      transaction.clientId,
      transaction.requestId,
    ])
    let changed = changes.has(identity)
      ? { ...structuredClone(transaction), operations: changes.get(identity) }
      : null
    if (!changed) {
      changed = structuredClone(transaction)
      // 同一原子事务的后续操作读取前序操作的结果，不能只查询提交前快照。
      const documents = new Map(
        (await store.snapshot(room)).documents.map(({ key, value }) => [key, value])
      )
      changed.operations = changed.operations.map((operation) => {
        let committed = operation
        if (operation.op === process.env.VELAR_EVAL_MUTATION) {
          if (operation.op === 'put') committed = { ...operation, value: wrong(operation.value) }
          else if (documents.has(operation.key))
            committed = { op: 'put', key: operation.key, value: documents.get(operation.key) }
        }
        if (committed.op === 'put') documents.set(committed.key, structuredClone(committed.value))
        else if (committed.op === 'delete') documents.delete(committed.key)
        else if (committed.op === 'patch')
          documents.set(committed.key, applyPatch(documents.get(committed.key), committed.patch))
        return committed
      })
      changes.set(identity, changed.operations)
    }
    const receipt = await transact(room, changed, ...options)
    if (JSON.stringify(changed.operations) !== JSON.stringify(transaction.operations)) {
      fs.appendFileSync(
        process.env.VELAR_EVAL_MUTATION_LOG,
        JSON.stringify({
          pid: process.pid,
          room,
          original: transaction,
          committed: changed,
          receipt,
          durable: await store.snapshot(room),
        }) + '\n'
      )
    }
    return receipt
  }
  return store
}
