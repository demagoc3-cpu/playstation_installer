import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.cwd(), directory = mkdtempSync(resolve(tmpdir(), 'packageflow-apps-')), mode = process.argv[2]
process.chdir(directory); mkdirSync('.data')
globalThis.createError = v => Object.assign(new Error(v.message), v)
registerHooks({ resolve(s, c, next) { try { return next(s,c) } catch(e) { if(s.startsWith('.') && !/\.[a-z]+$/.test(s)) return next(`${s}.ts`,c); throw e } } })
const ip = '192.168.88.147', token = 'abcdef0123456789abcdef0123456789'
writeFileSync('.data/ps4-service-keys.json',JSON.stringify({[ip]:token}))
const label = 'ABCDEFGHIJKLMNOP', revision = '0123456789abcdef'
const app = {titleId:'CUSA00001',title:'Real console game',version:'01.23',installed:true,protected:false}
const parts = [{id:'base',kind:'base',title:app.title,version:'01.00',contentId:'EP0000-CUSA00001_00-BASEGAME00000000',sizeBytes:8589934592,storage:'internal',canRemove:true}, {id:'patch',kind:'patch',title:app.title,version:'01.23',contentId:'EP0000-CUSA00001_00-BASEGAME00000000',sizeBytes:4096,storage:'internal',canRemove:true}, {id:label,kind:'dlc',title:'Expansion',version:'01.00',contentId:`EP0000-CUSA00001_00-${label}`,sizeBytes:2048,storage:'external',canRemove:true}]
const items = parts.map((p,i)=>({id:`item${i}`,title:'PC package',path:resolve(`file${i}.pkg`),libraryRoot:directory,fileName:`file${i}.pkg`,size:p.sizeBytes,sourceModifiedAt:1,installedAt:100,titleId:app.titleId,contentId:p.contentId,contentType:p.kind==='base'?'PS4GD':p.kind==='patch'?'PS4GP':'PS4AC',type:p.kind==='base'?'Игра':p.kind==='patch'?'Бэкпорт':'DLC',icon:{offset:0,size:0},iconSize:0,installOrder:i}))
writeFileSync('.data/package-library.json',JSON.stringify({version:2,packages:items,deliveries:{}}))
const input = {requestId:'11111111-1111-1111-1111-111111111111',titleId:app.titleId,kind:'dlc',componentId:label,revision,confirmTitleId:app.titleId}
let posts=0, gets=0, job
const response=(v,status=200)=>new Response(JSON.stringify(v),{status})
globalThis.fetch = async (url,options) => {
 const path = new URL(url).pathname; assert.equal(new URL(url).port,'12801'); assert.equal(options.redirect,'error'); assert.equal(options.headers.Authorization,`Bearer ${token}`)
 if(path==='/apps/list') return response({service:'PackegeFlowService',appsApi:1,revision,complete:true,total:1,next:null,apps:[app]})
 if(path.startsWith('/apps/title/')) return response({service:'PackegeFlowService',revision,complete:true,total:parts.length,next:null,app,components:parts})
 if(path==='/apps/remove') { posts++; assert.deepEqual(JSON.parse(options.body),input); job={service:'PackegeFlowService',requestId:input.requestId,titleId:app.titleId,kind:input.kind,componentId:label,state:'running',completed:0,total:1,error:0,errorHex:'0x00000000',pollError:0}; if(mode==='reject')return response({error:'inventory_changed_refresh'},409); throw new Error('Response lost after command was accepted') }
 assert.equal(path,`/apps/operations/${input.requestId}`); gets++; return response(job)
}
const load=async name=>import(pathToFileURL(resolve(root,`server/utils/${name}.ts`)).href)
try {
 const client=await load('ps4-console-apps')
 if(mode==='restart') {
  job={service:'PackegeFlowService',requestId:input.requestId,titleId:app.titleId,kind:input.kind,componentId:label,state:'removed',completed:1,total:1,error:0,errorHex:'0x00000000',pollError:0}
  writeFileSync('.data/ps4-remove-operations.json',JSON.stringify({version:1,operations:[{ip,input,createdAt:1,pending:true,result:{...job,state:'uncertain',completed:0}}]}))
  const value=await client.getConsoleRemoval(ip);assert.equal(value.state,'removed');assert.equal(posts,0);assert.equal(gets,1)
  await client.submitConsoleRemoval(ip,input);assert.equal(posts,0)
 }
 else if(mode==='corrupt') { writeFileSync('.data/ps4-remove-operations.json','corrupt'); await assert.rejects(client.submitConsoleRemoval(ip,input)); assert.equal(posts,0) }
 else if(mode==='busy') { writeFileSync('.data/installation-queue.json',JSON.stringify({psIp:ip,status:'running',items:[]})); await assert.rejects(client.submitConsoleRemoval(ip,input)); assert.equal(posts,0) }
 else {
  const catalog=await client.getConsoleCatalog(ip); assert.equal(catalog.apps[0].title,'Real console game'); const details=await client.getConsoleDetails(ip,app.titleId); assert.equal(details.components[0].sizeBytes,8589934592); assert.equal(details.components[2].id,label)
  assert.throws(()=>client.validateRemoval({...input,confirmTitleId:'CUSA00002'})); assert.throws(()=>client.validateRemoval({...input,componentId:'../evil'})); assert.throws(()=>client.validateRemoveResult({service:'PackegeFlowService',...input,state:'removed',completed:0,total:1,error:0,errorHex:'0x00000000',pollError:0},input))
  const result=await client.submitConsoleRemoval(ip,input); assert.equal(posts,1)
  if(mode==='reject') { assert.equal(result.state,'failed');assert.equal(result.pending,false); await client.submitConsoleRemoval(ip,input);assert.equal(posts,1) }
  else {
   assert.equal(result.state,'uncertain');assert.equal(result.pending,true)
   const store=await load('console-operation-store'); assert.throws(()=>store.assertNoRemoval(ip)); const queue=await load('installation-queue');assert.throws(()=>queue.startInstallationQueue({psIp:ip,packageIds:[],packageUrls:{}}))
   await client.submitConsoleRemoval(ip,input); assert.equal(posts,1)
   const running=await client.getConsoleRemoval(ip);assert.equal(running.state,'running');assert.equal(running.pending,false);assert.equal(gets,1)
   job.state='verifying';job.completed=1;const checking=await client.getConsoleRemoval(ip);assert.equal(checking.state,'verifying');assert(JSON.parse(readFileSync('.data/package-library.json')).packages.every(p=>p.installedAt))
   job.state='removed';const removed=await client.getConsoleRemoval(ip);assert.equal(removed.state,'removed'); const library=JSON.parse(readFileSync('.data/package-library.json')).packages;assert(library[0].installedAt&&library[1].installedAt);assert.equal(library[2].installedAt,undefined);store.assertNoRemoval(ip)
   await client.submitConsoleRemoval(ip,input);assert.equal(posts,1);assert.equal(JSON.stringify(removed).includes(token),false)
  }
 }
 console.log(`PASS: console ${mode}`)
} finally { rmSync(directory,{recursive:true,force:true}) }
