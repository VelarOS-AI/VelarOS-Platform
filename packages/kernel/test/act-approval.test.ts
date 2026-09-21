import {expect,test} from 'bun:test'

import {approvalContracts,createTaskApprovalState,defaultDenyApprovalPort} from '../src/index.js'
test('missing approval fails closed and stable identity includes all arguments',async()=>{
 await expect(defaultDenyApprovalPort.awaitConfirmation('write')).rejects.toThrow()
 const key=approvalContracts.createApprovalOperationKey
 expect(key('write',{run:'a',input:{x:1,y:2}})).toBe(key('write',{input:{y:2,x:1},run:'a'}))
 expect(key('write',{run:'a',input:1})).not.toBe(key('write',{run:'b',input:1}))
 expect(()=>key('write',{get secret(){throw Error('getter executed')}})).toThrow('访问器')
})
test('task approval revoke and disposal cannot be undone by late decisions',()=>{
 const ledger=createTaskApprovalState();ledger.record('a',true,{operation:{key:'a',label:'write'}})
 expect(ledger.has('a')).toBe(true);expect(ledger.revoke(ledger.list()[0]!.id)).toBe(true);expect(ledger.has('a')).toBe(false)
 ledger.record('b',false,{},'choose another');expect(ledger.denial('b')).toBe('choose another')
 ledger.dispose();expect(()=>ledger.record('a',true,{})).toThrow();expect(()=>ledger.has('a')).toThrow()
})
