import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseSync} from 'node:sqlite'
import {describe,test} from 'node:test'

import {localContextStorage} from '../dist/node.js'

import {storageContract,storeContract,volatileStorageBackend} from './support/storage-contract.mjs'

async function sqliteFixture(t){
 const dir=await mkdtemp(join(tmpdir(),'storage-contract-'))
 t.after(()=>rm(dir,{recursive:true,force:true}))
 return {open:()=>localContextStorage({path:join(dir,'state.sqlite')})}
}

describe('INV-12 storage adapters preserve persistence and lifecycle contracts',()=>{
 storageContract('SQLite',sqliteFixture)
 storeContract('SQLite',sqliteFixture)
 storageContract('opaque asynchronous test adapter',async()=>volatileStorageBackend())
})

test('SQLite initialization failure closes the connection it just opened',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'storage-init-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const path=join(dir,'state.sqlite');const db=new DatabaseSync(path)
 try{db.exec('CREATE TABLE context_records(session TEXT)')}finally{db.close()}
 const close=t.mock.method(DatabaseSync.prototype,'close')
 assert.throws(()=>localContextStorage({path}),/no such column/)
 assert.equal(close.mock.calls.length,1)
})
