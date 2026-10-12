import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const dir=mkdtempSync(join(tmpdir(),'pf-profile-'))
await build({stdin:{contents:"export * from './server/utils/ps5-transfer-profile';export * from './server/utils/ps5-send-chunks'",resolveDir:resolve('.')},bundle:true,platform:'node',format:'esm',outfile:join(dir,'api.mjs'),logLevel:'silent'})
const {ps5TransferProfile,ps5TransferProtocol}=await import(pathToFileURL(join(dir,'api.mjs')).href)
const bytes=33554432,profile={schemaVersion:1,hashMode:'sse2',offset:0,bytes,elapsedMs:120,receiveWaitMs:40,writeMs:20,hashMs:40,syncMs:2,checkpointMs:3,stateMs:1,replay:false,streamingHash:true}
test('exact qualified limits and validated optional phase telemetry',()=>{
 for(const size of [16777216,33554432,67108864,134217728])assert.deepEqual(ps5TransferProtocol({batchMax:size}),{path:'/api/v1/transfers/batch',size})
 assert.equal(ps5TransferProtocol({batchMax:268435456,chunkMax:4194304}).size,4194304)
 for(const size of [16777216,33554432,67108864,134217728])assert.equal(ps5TransferProfile({bytesDurable:size,profile:{...profile,bytes:size}},0,size,123).bytes,size)
 assert.equal(ps5TransferProfile({bytesDurable:134217729,profile:{...profile,bytes:134217729}},0,134217729),undefined)
 assert.equal(ps5TransferProfile({bytesDurable:bytes,profile},0,bytes,123).measuredAt,123)
 for(const patch of [{bytes:1},{offset:1},{replay:true},{streamingHash:false},{hashMode:'unknown'},{hashMs:NaN},{hashMs:-1},{writeMs:121},{schemaVersion:2}])assert.equal(ps5TransferProfile({bytesDurable:bytes,profile:{...profile,...patch}},0,bytes),undefined)
 assert.equal(ps5TransferProfile({bytesDurable:bytes-1,profile},0,bytes),undefined)
 assert.equal(ps5TransferProfile({bytesDurable:bytes},0,bytes),undefined)
})
test.after(()=>rmSync(dir,{recursive:true,force:true}))
