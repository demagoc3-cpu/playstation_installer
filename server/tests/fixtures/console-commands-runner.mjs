import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const root=process.cwd(), temp=mkdtempSync(resolve(tmpdir(),'packageflow-console-commands-'))
process.chdir(temp);mkdirSync('.data')
const calls={start:0,append:0,preview:0,reinstall:0,cancel:0};globalThis.commandCalls=calls
globalThis.commandQueue={status:'idle',items:[]}
const library=[{id:'base',titleId:'CUSA00001',fileName:'base.pkg',contentType:'PS4GD',installOrder:0},{id:'dlc',titleId:'CUSA00001',fileName:'dlc.pkg',contentType:'PS4AC',installOrder:2}]
globalThis.commandLibrary=library
registerHooks({
 resolve(s,c,next){try{return next(s,c)}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/.test(s))return next(s+'.ts',c);if(s==='h3')return {url:'mock:h3',shortCircuit:true};throw e}},
 load(url,c,next){
  if(url==='mock:h3')return {format:'module',shortCircuit:true,source:'export const createError = v => Object.assign(new Error(v.message),v)'}
  if(url.endsWith('/package-library.ts'))return {format:'module',shortCircuit:true,source:'export const getLibraryPackages = () => globalThis.commandLibrary'}
  if(url.endsWith('/ps4-installer.ts'))return {format:'module',shortCircuit:true,source:'export const getLocalIp = async () => "10.1.10.47"'}
  if(url.endsWith('/installation-queue.ts'))return {format:'module',shortCircuit:true,source:`
   export const getInstallationQueue=()=>globalThis.commandQueue;
   export const cancelGameInstallation=(id,ip,game)=>{if(game!=='CUSA00001')throw new Error('wrong game');globalThis.commandCalls.cancel++;globalThis.cancelledGame=game;return globalThis.commandQueue};
   export const cancelInstallationQueue=()=>{globalThis.commandCalls.cancel++;return globalThis.commandQueue};
   export const cancelCurrentInstallation=(id,pkg,ip)=>{if(pkg!=='dlc')throw new Error('current changed');globalThis.commandCalls.cancel++;return globalThis.commandQueue};
   export const startInstallationQueue=v=>{globalThis.commandCalls.start++;globalThis.lastCommand=v;return globalThis.commandQueue={id:'shared',psIp:v.psIp,transport:v.transport,status:'running',items:[]}};
   export const appendInstallationQueue=v=>{globalThis.commandCalls.append++;globalThis.lastCommand=v;return globalThis.commandQueue};
  `}
  if(url.endsWith('/console-maintenance.ts'))return {format:'module',shortCircuit:true,source:`
   export const reinstallPlan=async(ip,id)=>{globalThis.commandCalls.preview++;await new Promise(r=>setTimeout(r,20));return {packageId:id,details:{app:{titleId:'CUSA00001'},revision:'actual-revision',components:[{id:'base',title:'Game',kind:'base'}]}}};
   export const beginReinstall=async(ip,b)=>{globalThis.commandCalls.reinstall++;globalThis.lastBundle=b.bundle; if(b.revision!=='actual-revision'||b.confirmTitleId!=='CUSA00001')throw new Error('stale confirmation');return {id:'maintenance',state:globalThis.reinstallState||'removing',message:globalThis.reinstallState==='failed'?'Removal history full':'Removal started'}};
  `}
  return next(url,c)
 }
})
const {submitConsoleCommand,consoleCommand}=await import(pathToFileURL(resolve(root,'server/utils/console-app-commands.ts')).href)
const request=(n,action,extra={})=>({ip:'10.1.10.32',requestId:n.toString(16).padStart(32,'0'),gameId:'CUSA00001',action,...extra})
const finish=async b=>{let r;for(let i=0;i<30;i++){r=consoleCommand(b.requestId,b.ip);if(r.state!=='pending')return r;await new Promise(r=>setTimeout(r,5))}throw new Error('pending')}
try {
 const one=request(1,'selected',{packageIds:['dlc']});submitConsoleCommand(one,'3000');submitConsoleCommand(one,'3000');assert.equal((await finish(one)).state,'accepted');assert.equal(calls.start,1)
 assert.equal(globalThis.lastCommand.transport,'service');assert.deepEqual(globalThis.lastCommand.packageIds,['dlc']);assert.equal(globalThis.lastCommand.packageUrls.dlc,'http://10.1.10.47:3000/json/dlc.json')
 submitConsoleCommand(one,'3000');assert.equal(calls.start,1)
 assert.throws(()=>submitConsoleCommand({...one,action:'all'},'3000'))
 const two=request(2,'all');submitConsoleCommand(two,'3000');assert.equal((await finish(two)).state,'accepted');assert.equal(calls.append,1);assert.deepEqual(globalThis.lastCommand.packageIds,['base','dlc'])
 globalThis.commandQueue.psIp='10.1.10.33';const three=request(3,'all');submitConsoleCommand(three,'3000');assert.equal((await finish(three)).state,'failed');assert.equal(calls.append,1)
 assert.throws(()=>submitConsoleCommand(request(4,'selected',{packageIds:['other-game']}),'3000'));assert.equal(calls.start,1)
 const preview=request(5,'reinstall-preview');submitConsoleCommand(preview,'3000');const plan=await finish(preview);assert.equal(plan.state,'accepted');assert.equal(calls.reinstall,0);assert.equal(plan.result.revision,'actual-revision')
 const stale=request(6,'reinstall',{revision:'old',confirmTitleId:'CUSA00001'});submitConsoleCommand(stale,'3000');assert.equal((await finish(stale)).state,'failed')
 const good=request(7,'reinstall',{revision:plan.result.revision,confirmTitleId:plan.result.titleId});submitConsoleCommand(good,'3000');assert.equal((await finish(good)).state,'accepted');const count=calls.reinstall;submitConsoleCommand(good,'3000');assert.equal(calls.reinstall,count)
 assert.deepEqual(globalThis.lastBundle.packageIds,['base','dlc']);
 globalThis.commandQueue={id:'shared',psIp:'10.1.10.32',transport:'service',status:'running',items:[]};
 const cancel=request(8,'cancel-current',{queueId:'shared',currentPackageId:'dlc'});submitConsoleCommand(cancel,'3000');assert.equal((await finish(cancel)).state,'accepted');assert.equal(calls.cancel,1);submitConsoleCommand(cancel,'3000');assert.equal(calls.cancel,1);
 assert.throws(()=>submitConsoleCommand({...cancel,currentPackageId:'base'},'3000'));
 const old=request(9,'cancel-all',{queueId:'old'});submitConsoleCommand(old,'3000');assert.equal((await finish(old)).state,'failed');assert.equal(calls.cancel,1);
 globalThis.reinstallState='failed';const rejected=request(10,'reinstall',{revision:plan.result.revision,confirmTitleId:plan.result.titleId});submitConsoleCommand(rejected,'3000');const rejectedResult=await finish(rejected);assert.equal(rejectedResult.state,'failed');assert.equal(rejectedResult.message,'Removal history full');
 const game=request(11,'cancel-game',{queueId:'shared'});submitConsoleCommand(game,'3000');assert.equal((await finish(game)).state,'accepted');assert.equal(globalThis.cancelledGame,'CUSA00001');const cancellations=calls.cancel;submitConsoleCommand(game,'3000');assert.equal(calls.cancel,cancellations);
 const id='f'.repeat(32);writeFileSync('.data/console-app-commands.json',JSON.stringify({version:1,records:[{id,ip:'10.1.10.32',fingerprint:'x',state:'pending',message:''}]}));assert.equal(consoleCommand(id,'10.1.10.32').state,'uncertain');assert.throws(()=>consoleCommand(id,'10.1.10.33'))
 console.log('Production native commands: same service queue, append, replay protection, foreign selections, confirmed reinstall and interrupted WEB: passed')
}finally {process.chdir(root);rmSync(temp,{recursive:true,force:true})}
