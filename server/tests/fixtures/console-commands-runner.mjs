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
const library=[{title:'Game',size:1024,type:'Игра',contentId:'BASE',packageDigest:'a'.repeat(64),id:'base',titleId:'CUSA00001',fileName:'base.pkg',contentType:'PS4GD',installOrder:0},{title:'DLC',size:2048,type:'DLC',contentId:'DLC',packageDigest:'b'.repeat(64),id:'dlc',titleId:'CUSA00001',fileName:'dlc.pkg',contentType:'PS4AC',installOrder:2}]
globalThis.commandLibrary=library
registerHooks({
 resolve(s,c,next){try{return next(s,c)}catch(e){if(s.startsWith('.')&&!/\.[a-z]+$/.test(s))return next(s+'.ts',c);if(s==='h3')return {url:'mock:h3',shortCircuit:true};throw e}},
 load(url,c,next){
  if(url==='mock:h3')return {format:'module',shortCircuit:true,source:'export const createError = v => Object.assign(new Error(v.message),v)'}
  if(url.endsWith('/package-library.ts'))return {format:'module',shortCircuit:true,source:'export const getLibraryPackages = () => globalThis.commandLibrary'}
  if(url.endsWith('/ps4-installer.ts'))return {format:'module',shortCircuit:true,source:'export const getLocalIp = async () => "10.1.10.47"'}
  if(url.endsWith('/installation-queue.ts'))return {format:'module',shortCircuit:true,source:`
   export const getInstallationQueue=()=>globalThis.commandQueue;
   export const getInstallationHistory=()=>[];
   export const cancelInstallationItems=(id,pkgs,ip)=>{globalThis.commandCalls.cancel++;globalThis.cancelledItems=pkgs;return globalThis.commandQueue};
   export const cancelGameInstallations=(id,ip,games)=>{globalThis.commandCalls.cancel++;globalThis.cancelledGames=games;return globalThis.commandQueue};
   export const cancelInstallationItem=(id,pkg,ip)=>{if(id!==globalThis.commandQueue.id)throw new Error("stale queue");globalThis.commandCalls.cancel++;globalThis.cancelledItem=pkg;return globalThis.commandQueue};
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
 const presets=await import(pathToFileURL(resolve(root,'server/utils/presets.ts')).href)
 const preset=presets.mutatePreset({action:'create',name:'Racing'});presets.mutatePreset({action:'add',id:preset.id,packageIds:['base','dlc']})
 globalThis.commandLibrary=[...library,{...library[1],id:'outside',fileName:'outside.pkg',contentId:'OTHER',packageDigest:'c'.repeat(64)}]
 const presetAll=request(12,'install-preset',{gameId:preset.id});submitConsoleCommand(presetAll,'3000');assert.equal((await finish(presetAll)).state,'accepted');assert.deepEqual(globalThis.lastCommand.packageIds,['base','dlc'],'whole preset excludes other library packages');const appended=calls.append;submitConsoleCommand(presetAll,'3000');assert.equal(calls.append,appended)
 const presetSelected=request(13,'selected',{presetId:preset.id,packageIds:['base']});submitConsoleCommand(presetSelected,'3000');assert.equal((await finish(presetSelected)).state,'accepted');assert.deepEqual(globalThis.lastCommand.packageIds,['base']);assert.throws(()=>submitConsoleCommand({...presetSelected,presetId:'another'},'3000'),'preset context is part of replay identity')
 assert.throws(()=>submitConsoleCommand(request(14,'selected',{presetId:preset.id,packageIds:['outside']}),'3000'),'cannot install a package outside the preset')
 globalThis.commandLibrary=library.slice(0,1);assert.throws(()=>submitConsoleCommand(request(15,'install-preset',{gameId:preset.id}),'3000'),/отсутствует/)
 const available=request(16,'selected',{presetId:preset.id,packageIds:['base']});submitConsoleCommand(available,'3000');assert.equal((await finish(available)).state,'accepted','available package can be installed despite another missing preset file')
 globalThis.commandLibrary=[...library,...Array.from({length:300},(_,i)=>({...library[0],id:`favorite-${i}`,titleId:`CUSA${String(i+2).padStart(5,'0')}`,fileName:`game-${i}.pkg`}))];
 const favoriteIds=globalThis.commandLibrary.map(p=>p.titleId);
 const favorites=request(17,'install-favorites',{gameId:'',favoriteIds});submitConsoleCommand(favorites,'3000');assert.equal((await finish(favorites)).state,'accepted');assert.equal(globalThis.lastCommand.packageIds.length,302,'favorites include all packages beyond the loaded page');assert.equal(new Set(globalThis.lastCommand.packageIds).size,302);const favoriteAppends=calls.append;submitConsoleCommand(favorites,'3000');assert.equal(calls.append,favoriteAppends,'full favorites is replay safe');assert.throws(()=>submitConsoleCommand({...favorites,favoriteIds:['CUSA00001']},'3000'));
 assert.throws(()=>submitConsoleCommand(request(18,'install-favorites',{gameId:'',favoriteIds:['CUSA99999']}),'3000'),/отсутствуют/);
 globalThis.commandLibrary[0].sourceIds=['old-base'];
 const staleFavorites=request(22,'install-favorites',{gameId:'',favoriteIds:['old-base','CUSA99999','cusa00001']});submitConsoleCommand(staleFavorites,'3000');const staleResult=await finish(staleFavorites);assert.equal(staleResult.state,'accepted');assert.deepEqual(globalThis.lastCommand.packageIds,['base','dlc'],'stale saved IDs do not block valid whole branches');assert.equal(staleResult.result.missingFavorites,1);assert.match(staleResult.message,/Отсутствующих записей: 1/);
 globalThis.commandQueue.items=[{packageId:'base',state:'installed',bytesSent:1024,detail:'Installed'},{packageId:'dlc',state:'pending',bytesSent:0,detail:'Waiting'}];
 const clear=request(19,'clear-tasks',{gameId:''});submitConsoleCommand(clear,'3000');assert.equal((await finish(clear)).state,'accepted');assert.equal(consoleCommand(clear.requestId,clear.ip).result.cleared,1);assert.equal(globalThis.commandQueue.items.length,2,'clear hides rows without changing runner indices');
 const unqueue=request(20,'cancel-item',{queueId:'shared',currentPackageId:'dlc'});submitConsoleCommand(unqueue,'3000');assert.equal((await finish(unqueue)).state,'accepted');assert.equal(globalThis.cancelledItem,'dlc');
 const selectedCancel=request(23,'cancel-items',{queueId:'shared',packageIds:['base','dlc']});submitConsoleCommand(selectedCancel,'3000');assert.equal((await finish(selectedCancel)).state,'accepted');assert.deepEqual(globalThis.cancelledItems,['base','dlc']);const selectedCount=calls.cancel;submitConsoleCommand(selectedCancel,'3000');assert.equal(calls.cancel,selectedCount);assert.throws(()=>submitConsoleCommand({...selectedCancel,packageIds:['base']},'3000'));
 const selectedBranches=request(24,'cancel-games',{queueId:'shared',gameIds:['CUSA00001','CUSA00002']});submitConsoleCommand(selectedBranches,'3000');assert.equal((await finish(selectedBranches)).state,'accepted');assert.deepEqual(globalThis.cancelledGames,['CUSA00001','CUSA00002']);assert.throws(()=>submitConsoleCommand({...selectedBranches,gameIds:['CUSA00001']},'3000'));
 assert.throws(()=>submitConsoleCommand(request(25,'cancel-items',{queueId:'shared',packageIds:[]}),'3000'));assert.throws(()=>submitConsoleCommand(request(26,'cancel-games',{queueId:'shared',gameIds:['../bad']}),'3000'));
 const staleSelected=request(27,'cancel-items',{queueId:'old',packageIds:['base']});const beforeStale=calls.cancel;submitConsoleCommand(staleSelected,'3000');assert.equal((await finish(staleSelected)).state,'failed');assert.equal(calls.cancel,beforeStale);
 globalThis.commandQueue.psIp='10.1.10.33';const foreignClear=request(21,'clear-tasks',{gameId:''});submitConsoleCommand(foreignClear,'3000');assert.equal((await finish(foreignClear)).state,'accepted');assert.equal(consoleCommand(foreignClear.requestId,foreignClear.ip).result.cleared,0,'native clear only affects its console');
 const id='f'.repeat(32);writeFileSync('.data/console-app-commands.json',JSON.stringify({version:1,records:[{id,ip:'10.1.10.32',fingerprint:'x',state:'pending',message:''}]}));assert.equal(consoleCommand(id,'10.1.10.32').state,'uncertain');assert.throws(()=>consoleCommand(id,'10.1.10.33'))
 console.log('Production native commands: same service queue, append, replay protection, foreign selections, confirmed reinstall, portable presets, missing files and interrupted WEB: passed')
}finally {process.chdir(root);rmSync(temp,{recursive:true,force:true})}
