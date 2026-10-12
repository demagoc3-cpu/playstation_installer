import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { putPs5ParamPkg, ps5ParamFixture } from './fixtures/ps5-param-pkg.mjs'

const work=mkdtempSync(join(tmpdir(),'pf-existing-')), bundle=join(work,'api.mjs'),oldData=process.env.PACKAGEFLOW_DATA_DIR
process.env.PACKAGEFLOW_DATA_DIR=join(work,'data');mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
await build({stdin:{contents:"export * from './server/utils/installed-package-check'; export * from './server/utils/ps5-queue-driver'; export * from './server/utils/ps5-queue-core'; export * from './server/utils/console-profiles'; export * from './server/utils/package-library';",resolveDir:resolve('.')},outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const api=await import(pathToFileURL(bundle).href)
const base={id:'base',titleId:'CUSA95001',contentId:'IV0000-CUSA95001_00-PACKAGEFLOWUI001',appVersion:'01.00',installOrder:0,type:'Игра'}
const patch={...base,id:'patch',appVersion:'01.04',installOrder:1,type:'Патч'}
const dlc={...base,id:'dlc',contentId:'IV0000-CUSA95001_00-ANOTHERDLC000001',installOrder:2,type:'DLC'}
const components=[{kind:'base',version:'1.00',contentId:base.contentId},{kind:'patch',version:'1.03',contentId:base.contentId},{kind:'dlc',version:'',contentId:dlc.contentId}]
test('PS4 skips exact components, keeps a new patch/DLC, and protects an existing base of another version',()=>{
 assert.equal(api.matchInstalledComponent(base,components).state,'installed')
 assert.equal(api.matchInstalledComponent(patch,components).state,'absent')
 assert.equal(api.matchInstalledComponent({...patch,appVersion:'01.03'},components).state,'installed')
 assert.equal(api.matchInstalledComponent({...patch,appVersion:'01.02'},components).state,'base-present')
 assert.equal(api.matchInstalledComponent(dlc,components).state,'installed')
 assert.equal(api.matchInstalledComponent({...dlc,contentId:'different'},components).state,'absent')
 assert.equal(api.matchInstalledComponent({...base,appVersion:'01.05'},components).state,'base-present')
})
test('PS4 missing component is absence; a missing endpoint, incomplete or changing snapshot is not',async()=>{
 const missing=Object.assign(new Error('missing'),{statusCode:404,data:{serviceError:'component_not_found'}})
 assert.equal((await api.checkPs4InstalledPackage('192.168.1.4',base,false,async()=>{throw missing})).state,'absent')
 assert.equal((await api.checkPs4InstalledPackage('192.168.1.4',base,false,async()=>{throw Object.assign(new Error('unsupported'),{statusCode:404})})).state,'unavailable')
 const reply={service:'PackegeFlowService',app:{titleId:base.titleId,installed:true},complete:true,revision:'a'.repeat(16),total:3,next:null,components}
 assert.equal((await api.checkPs4InstalledPackage('192.168.1.4',base,false,async()=>reply)).state,'installed')
 assert.equal((await api.checkPs4InstalledPackage('192.168.1.4',base,false,async()=>({...reply,complete:false}))).state,'unavailable')
})
test('live PS5 version proves a patch; Title ID alone never proves a DLC',()=>{
 const row={installed:true,version:patch.appVersion,content_id:patch.contentId}
 assert.equal(api.matchPs5InstalledGame(patch,row,false).state,'installed')
 assert.equal(api.matchPs5InstalledGame({...patch,appVersion:'01.05'},row,true).state,'absent')
 assert.equal(api.matchPs5InstalledGame({...patch,appVersion:'01.03'},row,false).state,'base-present')
 assert.equal(api.matchPs5InstalledGame(dlc,row,false).state,'unavailable')
 assert.equal(api.matchPs5InstalledGame(dlc,row,true).state,'unavailable')
 assert.equal(api.matchPs5InstalledGame(dlc,{...row,installed:false},true).state,'absent')
})
test('live built-in registration without a source is a base review, never proof of selected version or a disconnected console',async()=>{
 const signal=new AbortController().signal
 const read=async(_id,path)=>({status:200,body:path.endsWith('/status')
  ? {protocol:'ps5-management-v1',ready:true,catalog:true}
  : path.endsWith('/catalog')
  ? {revision:'d'.repeat(64),entries:[{titleId:base.titleId,contentId:base.contentId,metadata:'{}'}],next:1,done:true}
  : {title_id:base.titleId,content_id:'IP9100-'+base.titleId+'_00-PREINMASTER00000',version:'0',installed:true,source_available:false,path:'',sourceIdentity:'e'.repeat(64)}})
 const v=await api.checkPs5InstalledPackage('fixture','192.168.1.5',base,signal,read)
 assert.equal(v.state,'base-present');assert.match(v.detail,/версия.*не подтверждена/);assert.equal(v.revision,'e'.repeat(64))
 const p=await api.checkPs5InstalledPackage('fixture','192.168.1.5',patch,signal,read)
 assert.equal(p.state,'unavailable');assert.match(p.detail,/PS5 отвечает/)
 const failed=await api.checkPs5InstalledPackage('fixture','192.168.1.5',base,signal,async()=>({status:503,body:{}}))
 assert.equal(failed.state,'unavailable')
})
test('already present base continues to new patches and the next game without falsely marking its selected version installed',async()=>{
 const q=api.ps5BlankQueue('test','192.168.1.5'),seen=[],marks=[]
 const item=(id,order=0,branch='ps5:PPSA95001')=>({packageId:id,title:id,titleId:branch.split(':')[1],fileName:`${id}.pkg`,size:100,type:order?'Патч':'Игра',platform:'ps5',format:'pkg',order,branch})
 const runner=new api.Ps5QueueRunner(q,()=>{}, {async run(v){seen.push(v.packageId);return v.packageId==='base'?{state:'skipped',alreadyPresent:true,detail:'exists'}:{state:'installed'}},async cancel(){}},5,v=>marks.push(v.packageId))
 runner.enqueue([item('base'),item('patch',1),item('next',0,'ps5:PPSA95002')]);await runner.settled()
 assert.deepEqual(seen,['base','patch','next']);assert.deepEqual(marks,['patch','next']);assert.equal(q.status,'completed')
})
test('production PS5 driver skips existing PKG/Folder before hashing, waits on uncertainty, and only an explicit PKG approval bypasses protection',async()=>{
 const oldFetch=globalThis.fetch
 try{
 const p=api.saveConsoleProfile({name:'Fixture PS5',platform:'ps5',ip:'192.168.1.5'}).consoles[0]
 writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR,'ps5-service-keys.json'),JSON.stringify({[p.ip]:'a'.repeat(64)}))
 const pkg={...base,title:'Fixture',titleId:'PPSA95001',contentId:'IV0000-PPSA95001_00-PACKAGEFLOWUI001',appVersion:'01.000.001',platform:'ps5',format:'pkg',fileName:'test.pkg',contentType:'PS5GD',size:8192,path:join(work,'test.pkg'),libraryRoot:work,sourceModifiedAt:1,icon:{offset:0,size:0},iconSize:0}
 writeFileSync(pkg.path,putPs5ParamPkg(Buffer.alloc(8192)))
 writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR,'package-library.json'),JSON.stringify({version:2,packages:[pkg],deliveries:{}}))
 const ready={service:'PackageFlowService-PS5',schemaVersion:1,route:'staged-pkg',ready:true,reason:'ready',formats:['pkg'],platforms:['ps4','ps5'],exactVersionReceipt:false,folder:{schemaVersion:1,route:'staged-folder',ready:true,platforms:['ps5']},images:{schemaVersion:1,route:'staged-image',ready:true,reason:'ready',platforms:['ps5'],formats:['ufs2','exfat','pfs','ffpfsc'],protocol:'image-registration-v1',backend:'ShadowMountPlus-1.7beta3',registrationReceipt:true}}
 const writes=[];let unavailable=false,found=true
 globalThis.fetch=async(url,opts={})=>{
 const path=new URL(url).pathname;if(opts.method==='POST')writes.push(path)
 const response=(body,status=200)=>new Response(JSON.stringify(body),{status})
 if(path==='/health')return response({apiVersion:'v1',firmwareRead:true,firmwareRaw:'0x13600007',serviceReport:{service:ready.service,platform:'ps5',consoleVerified:true}})
 if(path==='/api/v1/capabilities')return response({service:ready.service,capabilities:{installPs5Content:true,installPs4Pkg:true}})
 if(path==='/api/v1/system')return response({service:ready.service,storageRead:false})
 if(path==='/api/v1/install/readiness')return response(ready)
 if(path==='/api/v1/management/status')return response({protocol:'ps5-management-v1',ready:true,catalog:true})
 if(path==='/api/v1/console/catalog')return unavailable?response({},503):response({revision:'b'.repeat(64),entries:found?[{titleId:pkg.titleId,contentId:pkg.contentId,metadata:JSON.stringify({contentVersion:pkg.appVersion})}]:[],next:found?1:0,done:true})
 if(path==='/api/v1/console/info')return response({title_id:pkg.titleId,content_id:pkg.contentId,version:pkg.appVersion,installed:true,source_available:true,path:'/user/app/PPSA95001/app.pkg'})
 if(path==='/api/v1/transfers/begin')throw new Error('transfer reached explicitly')
 assert.fail(path)
 }
 await api.probeConsoleProfile(p.id)
 const driver=api.ps5QueueDriver(p.id),item=()=>({...pkg,packageId:pkg.id,order:0,branch:'ps5:PPSA95001',transferId:'b'.repeat(32),state:'pending',detail:'',bytesSent:0}),signal=new AbortController().signal
 let v=item();let result=await driver.run(v,signal,x=>Object.assign(v,x));assert.equal(result.state,'installed');assert.equal(result.confirmation,'service-existing');assert.equal(v.hash,undefined);assert.deepEqual(writes,[])
 const folder={...pkg,id:'folder',format:'folder',fileName:'folder',path:join(work,'folder')};mkdirSync(join(folder.path,'sce_sys'),{recursive:true});writeFileSync(join(folder.path,'eboot.bin'),Buffer.alloc(64));writeFileSync(join(folder.path,'sce_sys/param.json'),JSON.stringify(ps5ParamFixture()))
 writeFileSync(join(process.env.PACKAGEFLOW_DATA_DIR,'package-library.json'),JSON.stringify({version:2,packages:[pkg,folder],deliveries:{}}))
 const f={...item(),packageId:folder.id,format:'folder'};assert.equal((await driver.run(f,signal,x=>Object.assign(f,x))).state,'installed');assert.equal(f.hash,undefined);assert.deepEqual(writes,[])
 unavailable=true;v=item();assert.equal((await driver.run(v,signal,x=>Object.assign(v,x))).state,'waiting');assert.deepEqual(writes,[])
 unavailable=false;v={...item(),overwriteApproved:true};await assert.rejects(driver.run(v,signal,x=>Object.assign(v,x)),/transfer reached explicitly/);assert.deepEqual(writes,['/api/v1/transfers/begin'])
 // A fresh preview does not retain the previous positive snapshot after removal.
 found=false;assert.equal((await api.checkPs5InstalledPackage(p.id,p.ip,pkg,signal)).state,'absent')
 }finally{globalThis.fetch=oldFetch}
})
test.after(()=>{if(oldData===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=oldData;rmSync(work,{recursive:true,force:true})})
