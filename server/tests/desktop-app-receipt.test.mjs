import assert from 'node:assert/strict'
import { test } from 'node:test'
import { build } from 'esbuild'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const work=mkdtempSync(join(tmpdir(),'pf-setup-receipt-')),oldData=process.env.PACKAGEFLOW_DATA_DIR
process.env.PACKAGEFLOW_DATA_DIR=join(work,'data');mkdirSync(process.env.PACKAGEFLOW_DATA_DIR)
await build({stdin:{contents:"export * from './server/utils/desktop-console-setup'; export * from './server/utils/console-profiles';",resolveDir:resolve('.')},outfile:join(work,'api.mjs'),bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const api=await import(join(work,'api.mjs'))
const data=process.env.PACKAGEFLOW_DATA_DIR
const pkg={id:'fixture',title:'PackageFlow',titleId:'PPSA95001',contentId:'IV0000-PPSA95001_00-PACKAGEFLOWUI001',appVersion:'01.000.041',type:'Игра',installOrder:0,platform:'ps5',format:'ufs2',fileName:'fixture.ffpkg',path:join(work,'fixture.ffpkg'),size:8192,icon:{offset:0,size:0},iconSize:0}
writeFileSync(pkg.path,Buffer.alloc(pkg.size));writeFileSync(join(data,'package-library.json'),JSON.stringify({version:2,packages:[pkg],deliveries:{}}))

test('real setup request reconciles archived exact attempts against PS5 and never dispatches on replay',async()=>{
 const oldFetch=globalThis.fetch
 let present=true,uncertain=false,reads=0,writes=0
 globalThis.fetch=async(url,options={})=>{
  if(options.method==='POST'){writes++;assert.fail('replay must be read-only')}
  reads++
  const path=new URL(url).pathname,response=(body,status=200)=>new Response(JSON.stringify(body),{status})
  if(path==='/api/v1/management/status')return response({protocol:'ps5-management-v1',ready:true,catalog:true})
  if(path==='/api/v1/console/catalog')return uncertain?response({},503):response({revision:'a'.repeat(64),entries:present?[{titleId:pkg.titleId,contentId:pkg.contentId,metadata:JSON.stringify({contentVersion:pkg.appVersion})}]:[],next:present?1:0,done:true})
  if(path==='/api/v1/console/info')return response({title_id:pkg.titleId,content_id:pkg.contentId,version:pkg.appVersion,installed:true,source_available:true,path:'/data/homebrew/PPSA95001.ffpkg'})
  assert.fail(path)
 }
 try {
  const p=api.saveConsoleProfile({name:'Fixture',platform:'ps5',ip:'192.168.50.5'}).consoles[0]
  writeFileSync(join(data,'ps5-service-keys.json'),JSON.stringify({[p.ip]:'a'.repeat(64)}))
  const queueId='b'.repeat(32),requestId='c'.repeat(32),receipt={consoleId:p.id,ip:p.ip,requestId,packageId:pkg.id,queueId,state:'queued',sha256:'d'.repeat(64),startedAt:1}
  mkdirSync(join(data,'console-setup'),{recursive:true});const receiptPath=join(data,'console-setup',`app-${p.id}-${requestId}.json`);writeFileSync(receiptPath,JSON.stringify(receipt))
  mkdirSync(join(data,'consoles',p.id),{recursive:true})
  const item={packageId:pkg.id,title:pkg.title,titleId:pkg.titleId,fileName:pkg.fileName,size:pkg.size,type:pkg.type,platform:pkg.platform,format:pkg.format,branch:'ps5:'+pkg.titleId,order:0,transferId:'e'.repeat(32),queueId,state:'installed',detail:'done',bytesSent:pkg.size}
  // Another queue has since completed. The exact setup attempt is in history.
  writeFileSync(join(data,'consoles',p.id,'ps5-installation-queue.json'),JSON.stringify({version:1,id:'f'.repeat(32),consoleId:p.id,psIp:p.ip,transport:'service',status:'completed',items:[],history:[[item]],createdAt:1,updatedAt:2,message:''}))
  assert.equal((await api.installDesktopPs5App(p.id,requestId)).retry,'installed')
  present=false
  assert.equal((await api.installDesktopPs5App(p.id,requestId)).retry,'absent')
  uncertain=true
  assert.equal((await api.installDesktopPs5App(p.id,requestId)).retry,'unavailable')
  assert.ok(reads>=6);assert.equal(writes,0)
  assert.deepEqual(JSON.parse(readFileSync(receiptPath,'utf8')),receipt,'replay preserves the durable original request')
 } finally {globalThis.fetch=oldFetch}
})
test.after(()=>{if(oldData===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=oldData;rmSync(work,{recursive:true,force:true})})
