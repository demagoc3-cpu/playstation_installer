import assert from 'node:assert/strict'
import {test} from 'node:test'
import {build} from 'esbuild'
import {mkdtempSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
const work=mkdtempSync(join(tmpdir(),'pf-app-upgrade-'))
await build({entryPoints:['server/utils/desktop-app-upgrade.ts'],outfile:join(work,'driver.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const {upgradeDesktopApp,desktopAppDeleteWasNotDispatched}=await import(join(work,'driver.mjs'))
const target={consoleId:'fixture',ip:'192.168.50.5',sha256:'a'.repeat(64),titleId:'PPSA95001',contentId:'IV0000-PPSA95001_00-PACKAGEFLOWUI001',version:'01.000.042'}
function fixture() {
 const f={journal:null,writes:[],commands:new Map(),active:{running:false,appId:0,titleId:''},current:{titleId:target.titleId,contentId:target.contentId,path:'/data/homebrew/PPSA95001.ffpkg',version:'01.000.041',installed:true,managed:true,sourceAvailable:true,canManageSource:true,sourceIdentity:'b'.repeat(64)},unconfirmed:false}
 let next=1
 f.ports={readJournal:()=>f.journal,saveJournal:j=>{f.journal=j},info:async()=>f.current,activity:async()=>f.active,
  hasCommand:id=>f.commands.has(id),status:async id=>f.commands.get(id),presence:async()=>({state:'absent'}),newId:()=>String(next++).padStart(32,'0'),
  command:async body=>{assert.ok(f.journal,'Intent must be written before dispatch');f.writes.push(body);const result={state:f.unconfirmed?'unconfirmed':'accepted',result:{status:0}};f.commands.set(body.requestId,result);if(body.action==='stop')f.active={running:false,appId:0,titleId:''};return result}}
 return f
}
test('replaces only the older owned app and retries observe the same deletion',async()=>{
 const f=fixture();assert.equal((await upgradeDesktopApp(target,f.ports)).state,'absent');await upgradeDesktopApp(target,f.ports)
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].action,'delete');assert.equal(f.writes[0].sourceIdentity,f.current.sourceIdentity)
})
test('closes only PackageFlow, with a bound running app ID, before deleting',async()=>{
 const f=fixture();f.active={running:true,titleId:'PPSA95001',appId:17};await upgradeDesktopApp(target,f.ports)
 assert.deepEqual(f.writes.map(w=>w.action),['stop','delete']);assert.equal(f.writes[0].expectedAppId,17)
 await upgradeDesktopApp(target,f.ports);assert.equal(f.writes.length,2)
})
test('an explicit build replacement accepts the same version, never a downgrade',async()=>{
 const f=fixture();f.current.version=target.version
 await upgradeDesktopApp({...target,replaceSameVersion:true},f.ports)
 assert.equal(f.writes.length,1);assert.equal(f.writes[0].action,'delete')
 const newer=fixture();newer.current.version='01.000.043'
 await assert.rejects(upgradeDesktopApp({...target,replaceSameVersion:true},newer.ports),{statusCode:409});assert.equal(newer.writes.length,0)
})
test('native stop receipt uses code zero rather than the ShadowMount status field',async()=>{
 const f=fixture();f.active={running:true,titleId:'PPSA95001',appId:17}
 const command=f.ports.command;f.ports.command=async body=>{const r=await command(body);if(body.action==='stop'){r.result={code:0,running:false};f.commands.set(body.requestId,r)}return r}
 await upgradeDesktopApp(target,f.ports);assert.deepEqual(f.writes.map(w=>w.action),['stop','delete'])
})
test('a proven first-delete preflight rejection is recorded, then revoked before a later dispatch',async()=>{
 const f=fixture(),failure=Object.assign(new Error('Local preflight rejected delete'),{data:{commandNotDispatched:true}})
 f.ports.command=async()=>{throw failure}
 await assert.rejects(upgradeDesktopApp(target,f.ports),error=>error===failure)
 assert.equal(f.commands.size,0);assert.equal(f.writes.length,0)
 assert.equal(desktopAppDeleteWasNotDispatched(f.journal),true)
 for(const patch of [{requestId:'f'.repeat(32)},{sourceIdentity:'f'.repeat(64)},{sha256:'f'.repeat(64)},{ip:'192.168.50.6'}])
  assert.equal(desktopAppDeleteWasNotDispatched({...f.journal,deleteNotDispatched:{...f.journal.deleteNotDispatched,...patch}}),false)
 f.ports.command=async body=>{
  assert.equal(f.journal.deleteNotDispatched,undefined,'old safe rejection must be revoked before the next mutation can be attempted')
  const result={state:'unconfirmed'};f.commands.set(body.requestId,result);f.writes.push(body);return result
 }
 await assert.rejects(upgradeDesktopApp(target,f.ports),{statusCode:409})
 assert.equal(f.writes.length,1);assert.equal(desktopAppDeleteWasNotDispatched(f.journal),false)
})
test('unknown outcomes, existing command records, prior stops and legacy journals never gain presend proof',async()=>{
 const failure=()=>Object.assign(new Error('Preflight rejected'),{data:{commandNotDispatched:true}})
 for(const scenario of ['unknown','recorded','after-stop','orphan','legacy']) {
  const f=fixture(),send=f.ports.command
  if(scenario==='after-stop')f.active={running:true,titleId:target.titleId,appId:17}
  if(scenario==='orphan'){Object.assign(f.current,{sourceAvailable:false,managed:false,canManageSource:false});f.ports.presence=async()=>({state:'base-present'})}
  if(scenario==='legacy')f.journal={consoleId:target.consoleId,ip:target.ip,sha256:target.sha256,titleId:target.titleId,sourceIdentity:f.current.sourceIdentity,deleteId:'1'.repeat(32)}
  f.ports.command=async body=>{
   if(body.action==='stop')return send(body)
   if(scenario==='recorded')f.commands.set(body.requestId,{state:'unconfirmed'})
   throw scenario==='unknown'?new Error('Lost acknowledgement'):failure()
  }
  await assert.rejects(upgradeDesktopApp({...target,repairMissingSource:scenario==='orphan'},f.ports))
  assert.equal(f.journal.deleteNotDispatched,undefined,scenario)
  assert.equal(desktopAppDeleteWasNotDispatched(f.journal),false,scenario)
 }
})
test('retained registration allows repair only after live source absence is confirmed',async()=>{
 const f=fixture();f.ports.presence=async()=>({state:f.writes.some(w=>w.action==='uninstall')?'absent':'base-present'});f.ports.info=async()=>f.writes.length?{...f.current,sourceAvailable:false}:f.current
 assert.equal((await upgradeDesktopApp({...target,replaceSameVersion:true},f.ports)).state,'absent')
 assert.deepEqual(f.writes.map(w=>w.action),['delete','uninstall'])
 const uncertain=fixture();uncertain.ports.presence=async()=>({state:'installed'})
 await assert.rejects(upgradeDesktopApp(target,uncertain.ports),{statusCode:409});assert.equal(uncertain.writes.length,1)
 await assert.rejects(upgradeDesktopApp(target,uncertain.ports),{statusCode:409});assert.equal(uncertain.writes.length,1)
})
test('an owned missing source is unregistered before publishing a replacement',async()=>{
 const f=fixture();Object.assign(f.current,{sourceAvailable:false,managed:false,canManageSource:false})
 f.ports.presence=async()=>({state:f.writes.length?'absent':'base-present'})
 await upgradeDesktopApp({...target,repairMissingSource:true},f.ports)
 assert.deepEqual(f.writes.map(w=>w.action),['uninstall']);assert.equal(f.writes[0].confirmTitleId,'PPSA95001')
 const lost=fixture();Object.assign(lost.current,{sourceAvailable:false,managed:false,canManageSource:false});lost.unconfirmed=true;lost.ports.presence=async()=>({state:'base-present'})
 await assert.rejects(upgradeDesktopApp({...target,repairMissingSource:true},lost.ports),{statusCode:409})
 await assert.rejects(upgradeDesktopApp({...target,repairMissingSource:true},lost.ports),{statusCode:409});assert.equal(lost.writes.length,1)
})
test('accepted ShadowMount deletion is observed to completion before replacement',async()=>{
 const f=fixture();f.current.path='/data/homebrew/PPSA95001.ffpkg';let polls=0
 const command=f.ports.command;f.ports.command=async body=>{const r=await command(body);r.result={status:0,job_id:7,source:f.current.path,active:true,state:'running'};return r}
 f.ports.pause=async()=>{};f.ports.storage=async id=>{assert.equal(id,f.journal.deleteId);polls++;return{storage:{job_id:7,source:f.current.path,active:polls<2,state:polls<2?'running':'completed',result_status:0}}}
 await upgradeDesktopApp(target,f.ports);assert.equal(polls,2);assert.equal(f.journal.deleted,true)
 await upgradeDesktopApp(target,f.ports);assert.equal(f.writes.length,1);assert.equal(polls,2)
 const uncertain=fixture();const send=uncertain.ports.command;uncertain.ports.command=async body=>{const r=await send(body);r.result={status:0,job_id:8,active:true};return r};uncertain.ports.pause=async()=>{};uncertain.ports.storage=async()=>({storage:{job_id:8,active:true}})
 await assert.rejects(upgradeDesktopApp(target,uncertain.ports),{statusCode:409});assert.equal(uncertain.writes.length,1);assert.notEqual(uncertain.journal.deleted,true)
})
test('unknown, foreign, newer, unmanaged sources and other active games never mutate',async()=>{
 for(const patch of [{version:'01.000.042'},{version:'01.000.043'},{version:'?'},{contentId:'foreign'},{sourceIdentity:'?'},{installed:false},{managed:false},{sourceAvailable:false},{canManageSource:false}]) {
  const f=fixture();Object.assign(f.current,patch);await assert.rejects(upgradeDesktopApp(target,f.ports),{statusCode:409});assert.equal(f.writes.length,0);assert.equal(f.journal,null)
 }
 const f=fixture();f.active={running:true,titleId:'PPSA12345',appId:18};await assert.rejects(upgradeDesktopApp(target,f.ports),{statusCode:409});assert.equal(f.writes.length,0)
})
test('lost stop/delete acknowledgement and changed targets block further dispatch',async()=>{
 for(const active of [false,true]) {
  const f=fixture();f.unconfirmed=true;if(active)f.active={running:true,titleId:'PPSA95001',appId:17}
  await assert.rejects(upgradeDesktopApp(target,f.ports),{statusCode:409});await assert.rejects(upgradeDesktopApp(target,f.ports),{statusCode:409});assert.equal(f.writes.length,1)
  await assert.rejects(upgradeDesktopApp({...target,sha256:'c'.repeat(64)},f.ports),{statusCode:409});assert.equal(f.writes.length,1)
 }
})
test.after(()=>rmSync(work,{recursive:true,force:true}))
