import assert from 'node:assert/strict'
import {test} from 'node:test'
import {build} from 'esbuild'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
const work=mkdtempSync(join(tmpdir(),'pf-desktop-flow-')),oldData=process.env.PACKAGEFLOW_DATA_DIR,oldFetch=globalThis.fetch
process.env.PACKAGEFLOW_DATA_DIR=join(work,'data');mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
await build({stdin:{contents:"export * from './server/utils/desktop-console-setup'; export * from './server/utils/console-profiles'; export * from './server/utils/console-forget';",resolveDir:resolve('.')},outfile:join(work,'api.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent',banner:{js:"import {createRequire} from 'node:module';const require=createRequire(import.meta.url);"}})
const api=await import(join(work,'api.mjs')),data=process.env.PACKAGEFLOW_DATA_DIR
const param=Buffer.from(JSON.stringify({titleId:'PPSA95001',contentId:'IV0000-PPSA95001_00-PACKAGEFLOWUI001',contentVersion:'01.000.041',applicationCategoryType:0,requiredSystemSoftwareVersion:'0x0800000000000000',localizedParameters:{defaultLanguage:'en-US','en-US':{titleName:'PackageFlow'}}}))
function exfat() {
  const b = Buffer.alloc(1024 * 1024); b.write('EXFAT   ', 3); b.writeUInt16LE(0xaa55, 510)
  b[108] = 9; b[109] = 0; b[110] = 1; b.writeBigUInt64LE(BigInt(b.length / 512), 72)
  b.writeUInt32LE(24, 80); b.writeUInt32LE(16, 84); b.writeUInt32LE(128, 88); b.writeUInt32LE(1792, 92); b.writeUInt32LE(2, 96)
  function entry(at, name, dir, cluster, size) {
    b[at] = 0x85; b[at + 1] = 2; b.writeUInt16LE(dir ? 0x10 : 0, at + 4)
    b[at + 32] = 0xc0; b[at + 33] = 2; b[at + 35] = name.length; b.writeUInt32LE(cluster, at + 52); b.writeBigUInt64LE(BigInt(size), at + 56)
    b[at + 64] = 0xc1; b.write(name, at + 66, 'utf16le')
  }
  entry(65536, 'sce_sys', true, 3, 512); entry(65536 + 96, 'eboot.bin', false, 5, 16)
  entry(65536 + 512, 'param.json', false, 4, param.length); param.copy(b, 65536 + 1024); b.write('owned SELF bytes', 65536 + 1536)
  return b
}

const elf=Buffer.alloc(8192);Buffer.from('7f454c460201','hex').copy(elf);elf.writeUInt16LE(62,18)
const image=exfat(),artifact=(fileName,bytes)=>({fileName,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})
const manifest={schemaVersion:1,elf:{...artifact('service.elf',elf),firmware:'13.60',version:'0.1.15-dev',buildId:'fixture'},app:{...artifact('PackageFlow.exfat',image),name:'PackageFlow',titleId:'PPSA95001',contentId:'IV0000-PPSA95001_00-PACKAGEFLOWUI001',version:'01.000.041',format:'exfat'}}
mkdirSync(join(data,'console-setup'));writeFileSync(join(data,'console-setup','manifest.json'),JSON.stringify(manifest));writeFileSync(join(data,'console-setup',manifest.elf.fileName),elf);writeFileSync(join(data,'console-setup',manifest.app.fileName),image)
const p=api.saveConsoleProfile({name:'Fixture',platform:'ps5',ip:'192.168.50.5'}).consoles[0]
const other=api.saveConsoleProfile({name:'PS4',platform:'ps4',ip:'192.168.50.4'}).consoles[1]
writeFileSync(join(data,'ps5-service-keys.json'),JSON.stringify({[p.ip]:'a'.repeat(64),'192.168.50.8':'b'.repeat(64)}))
writeFileSync(join(data,'ps4-service-keys.json'),JSON.stringify({[other.ip]:'c'.repeat(32)}))
let pairingMode='automatic',pairCalls=0;
let mode='installed',writes=0,running=false,managed=true,sourceAvailable=true,contentId=manifest.app.contentId
const game=()=>({title_id:manifest.app.titleId,title_name:'PackageFlow',platform:'ps5',source_type:'image',image_type:'exfat',version:manifest.app.version,content_id:contentId,path:'/data/homebrew/PPSA95001.exfat',installed:true,mounted:true,managed,source_available:sourceAvailable,can_manage_source:true,can_uninstall:true,sourceIdentity:'d'.repeat(64)})
globalThis.fetch=async(url,options={})=>{
 const path=new URL(url).pathname,response=(body,status=200)=>new Response(JSON.stringify(body),{status})
 if(path==='/api/v1/pair'){pairCalls++;assert.equal(options.method,'POST');assert.equal(options.headers['X-PackageFlow-Pairing-Mode'],'automatic');assert.equal(options.headers['X-PackageFlow-Pairing-Code'],undefined);return response({apiVersion:'v1',pairingMode:'automatic',token:'a'.repeat(64)})}
 if(path==='/api/v1/web/config')return response({service:'PackageFlowService-PS5',webConfigured:true,webHost:options.headers['X-PackageFlow-Web-Host'],webPort:Number(options.headers['X-PackageFlow-Web-Port']),webConsoleId:options.headers['X-PackageFlow-Console-Id']})
 if(path==='/api/v1/console/command') {writes++;assert.equal(options.headers['X-PackageFlow-Title'],'PPSA95001');assert.equal(options.headers['X-PackageFlow-Action'],'delete');return response({requestId:options.headers['X-PackageFlow-Request-Id'],titleId:'PPSA95001',action:'delete',state:'accepted',result:{status:0}})}
 assert.notEqual(options.method,'POST')
 if(path==='/health')return response({apiVersion:'v1',pairingMode,firmwareRead:true,firmwareRaw:'0x13600000',serviceReport:{service:'PackageFlowService-PS5',platform:'ps5',consoleVerified:true,version:'0.1.15-dev'}})
 if(path==='/api/v1/capabilities')return response({service:'PackageFlowService-PS5',capabilities:{}})
 if(path==='/api/v1/system')return response({service:'PackageFlowService-PS5',storageRead:false})
 if(path==='/api/v1/install/readiness')return response({service:'PackageFlowService-PS5',schemaVersion:1,images:{schemaVersion:1,route:'staged-image',ready:true,reason:'ready',protocol:'image-registration-v1',backend:'ShadowMountPlus-1.7beta3',registrationReceipt:true,platforms:['ps5'],formats:['ufs2','exfat','pfs','ffpfsc']}})
 if(path==='/api/v1/management/status')return response({protocol:'ps5-management-v1',ready:true,catalog:true,consoleControl:true,consoleActivity:true})
 if(path==='/api/v1/console/catalog')return mode==='unknown'?response({},503):response({revision:'e'.repeat(64),entries:[{titleId:manifest.app.titleId,contentId,metadata:JSON.stringify({contentVersion:manifest.app.version})}],next:1,done:true})
 if(path==='/api/v1/console/info')return response(game())
 if(path==='/api/v1/console/activity')return response({complete:true,running,appId:running?10:0,titleId:running?'PPSA95001':''})
 assert.fail(path)
}
test('connection without a PIN validates service mode and retains credentials on repeat',async()=>{
 pairingMode=undefined;await assert.rejects(api.pairConsoleProfile(p.id,'http://192.168.50.1:3000'),{statusCode:409});assert.equal(pairCalls,0)
 pairingMode='automatic';await api.pairConsoleProfile(p.id,'http://192.168.50.1:3000');await api.pairConsoleProfile(p.id,'http://192.168.50.1:3000');assert.equal(pairCalls,2)
 assert.equal(JSON.parse(readFileSync(join(data,'ps5-service-keys.json'),'utf8'))[p.ip],'a'.repeat(64))
})
test('first request reads the console and skips an already installed app without dispatch or receipt',async()=>{
 assert.equal((await api.installDesktopPs5App(p.id,'1'.repeat(32))).retry,'installed');assert.equal(writes,0)
 assert.throws(()=>readFileSync(join(data,'console-setup',`app-${p.id}-${'1'.repeat(32)}.json`)),{code:'ENOENT'})
 mode='unknown';await assert.rejects(api.installDesktopPs5App(p.id,'2'.repeat(32)),{statusCode:409});assert.equal(writes,0);mode='installed'
})
test('orphan repair cannot overwrite a foreign identity or mistake a present source for absence',async()=>{
 sourceAvailable=false;contentId='IV0000-PPSA95001_00-OTHERAPP';await assert.rejects(api.installDesktopPs5App(p.id,'5'.repeat(32)),{statusCode:409});assert.equal(writes,0)
 sourceAvailable=true;contentId=manifest.app.contentId
})
test('app removal is source deletion, bound to its exact identity; replay never dispatches again',async()=>{
 running=true;await assert.rejects(api.removeDesktopPs5App(p.id,'3'.repeat(32),true),{statusCode:409});running=false
 managed=false;await assert.rejects(api.removeDesktopPs5App(p.id,'3'.repeat(32),true),{statusCode:409});managed=true
 contentId='IV0000-PPSA95001_00-OTHERAPP';await assert.rejects(api.removeDesktopPs5App(p.id,'3'.repeat(32),true),{statusCode:409});contentId=manifest.app.contentId
 assert.equal(writes,0)
 assert.equal((await api.removeDesktopPs5App(p.id,'3'.repeat(32),true)).state,'accepted');assert.equal(writes,1)
 // The source can disappear after acceptance; replay must read its durable receipt first.
 contentId='gone';assert.equal((await api.removeDesktopPs5App(p.id,'3'.repeat(32),true)).state,'accepted');assert.equal(writes,1)
})
test('forgetting one offline device erases its key only, and re-adding it cannot restore trusted access',()=>{
 assert.throws(()=>api.forgetConsole(p.id,false),{statusCode:400})
 mkdirSync(join(data,'ps5-save-restores'),{recursive:true});const pending=join(data,'ps5-save-restores','4'.repeat(32)+'.json')
 writeFileSync(pending,JSON.stringify({consoleId:p.id,state:'pending'}));assert.throws(()=>api.forgetConsole(p.id,true),{statusCode:409})
 assert.equal(api.consolePairConfigured(p.id),true,'unfinished restoration must retain the key')
 rmSync(pending)
 const result=api.forgetConsole(p.id,true);assert.equal(result.remotePairing,'unchanged');assert.equal(result.profiles.consoles.length,1)
 assert.equal(JSON.parse(readFileSync(join(data,'ps5-service-keys.json'),'utf8'))[p.ip],undefined)
 assert.equal(JSON.parse(readFileSync(join(data,'ps5-service-keys.json'),'utf8'))['192.168.50.8'],'b'.repeat(64))
 assert.equal(JSON.parse(readFileSync(join(data,'ps4-service-keys.json'),'utf8'))[other.ip],'c'.repeat(32))
 const readded=api.saveConsoleProfile({name:'Again',ip:p.ip,platform:'ps5'}).consoles.find(row=>row.ip===p.ip);assert.equal(api.consolePairConfigured(readded.id),false)
})
test.after(()=>{assert.equal(writes,1,'all scenarios must finish with exactly one destructive dispatch');console.log('PASS: live app check, bound source deletion, replay and forgotten-device credentials');globalThis.fetch=oldFetch;if(oldData===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=oldData;rmSync(work,{recursive:true,force:true})})
