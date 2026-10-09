import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { createError } from 'h3'

function fixture(label) {
  const pairs=Object.entries({ CATEGORY:'gd', CONTENT_ID:'EP0000-CUSA00001_00-TESTPACKAGE000000', TITLE_ID:'CUSA00001', TITLE:'Storage test', APP_VER:'01.00' })
  const keys=Buffer.from(pairs.map(([k])=>k+'\0').join('')), values=Buffer.from(pairs.map(([,v])=>v+'\0').join(''))
  const keyStart=20+pairs.length*16,valueStart=keyStart+keys.length,sfo=Buffer.alloc(valueStart+values.length)
  sfo.writeUInt32LE(0x46535000);sfo.writeUInt32LE(keyStart,8);sfo.writeUInt32LE(valueStart,12);sfo.writeUInt32LE(pairs.length,16)
  let k=0,v=0;pairs.forEach(([key,value],i)=>{const at=20+i*16;sfo.writeUInt16LE(k,at);sfo.writeUInt16LE(0x204,at+2);sfo.writeUInt32LE(value.length+1,at+4);sfo.writeUInt32LE(v,at+12);k+=key.length+1;v+=value.length+1})
  keys.copy(sfo,keyStart);values.copy(sfo,valueStart)
  const pkg=Buffer.alloc(0x4000);Buffer.from('7f434e54','hex').copy(pkg);pkg.writeUInt32BE(1,0x10);pkg.writeUInt32BE(0x1000,0x18);pkg.writeUInt32BE(0x1a,0x74);pkg.writeUInt32BE(0x1000,0x1000);pkg.writeUInt32BE(0x2000,0x1010);pkg.writeUInt32BE(sfo.length,0x1014);sfo.copy(pkg,0x2000);createHash('sha256').update(label).digest().copy(pkg,0xfe0);return pkg
}
async function context(run) {
  const work=mkdtempSync(join(tmpdir(),'pf-storage-')),oldData=process.env.PACKAGEFLOW_DATA_DIR,oldError=globalThis.createError
  process.env.PACKAGEFLOW_DATA_DIR=join(work,'data');mkdirSync(process.env.PACKAGEFLOW_DATA_DIR);globalThis.createError=createError
  try {
    const bundle=join(work,'storage.mjs');await build({stdin:{contents:`export * from './server/utils/storage-sources';export * from './server/utils/storage-secrets';export * from './server/utils/storage-connector';export * from './server/utils/package-library';`,resolveDir:resolve('.')},outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
    const api=await import(pathToFileURL(bundle).href);await run(api,work,process.env.PACKAGEFLOW_DATA_DIR)
  } finally {if(oldData===undefined)delete process.env.PACKAGEFLOW_DATA_DIR;else process.env.PACKAGEFLOW_DATA_DIR=oldData;globalThis.createError=oldError;rmSync(work,{recursive:true,force:true})}
}
const connector=()=>({ connect:async()=>{},disconnect:async()=>{},close:()=>{} })

test('storage migration, isolated reindex, overlapping ownership, canonical duplicate IDs and installation history survive source removal',()=>context(async(api,work)=>{
  const root=join(work,'games'),child=join(root,'nested'),other=join(work,'copies');mkdirSync(child,{recursive:true});mkdirSync(other)
  const original=join(child,'game.pkg');writeFileSync(original,fixture('base'));copyFileSync(original,join(other,'copy.pkg'));writeFileSync(join(other,'variant.pkg'),fixture('variant'))
  await api.scanPackageFolder(root);await api.scanPackageFolder(other)
  const before=api.getLibraryPackages(),base=before.find(p=>p.fileName==='game.pkg'),canonical=base.id;api.markPackageInstalled(canonical,true)
  const manager=api.createStorageManager(connector()),migrated=manager.list().sources
  assert.equal(migrated.length,2);assert.equal(api.getLibraryPackages().length,2)
  const rootSource=migrated.find(s=>s.path===root)
  const nested=await manager.save({kind:'local',path:child,name:'Nested'});await manager.settle()
  await manager.remove(nested.id);assert.equal(api.getLibraryPackages().length,2,'other ownership retains overlapping files')
  writeFileSync(join(root,'added.pkg'),fixture('added'));writeFileSync(join(root,'invalid.pkg'),'x');unlinkSync(original)
  manager.action(rootSource.id,'index');await manager.settle()
  assert.equal(api.getLibraryPackages().length,3,'removed original falls back to identical copy and variants survive')
  assert.equal(api.getPackage(canonical).path,join(other,'copy.pkg'),'accepted URL survives primary source prune')
  assert.ok(api.getLibraryPackages().find(p=>p.id===canonical).installedAt)
  await manager.remove(rootSource.id)
  assert.equal(api.getLibraryPackages().length,2);assert.equal(api.getPackage(canonical).path,join(other,'copy.pkg'))
  assert.ok(readFileSync(join(other,'copy.pkg')).length)
  const copySource=manager.list().sources.find(s=>s.path===other);manager.action(copySource.id,'rebuild');await manager.settle()
  assert.equal(api.getPackage(canonical).path,join(other,'copy.pkg'),'full metadata rebuild also retains accepted IDs')
}))

test('offline and mid-scan I/O failure retain the previous catalogue; active queues block destructive changes without sending requests',()=>context(async(api,work,data)=>{
  const root=join(work,'games');mkdirSync(root);const pkg=join(root,'game.pkg');writeFileSync(pkg,fixture('base'))
  let offline=false,connections=0
  const c=connector();c.connect=async()=>{connections++;if(offline)throw new Error('credential details must never appear')}
  const manager=api.createStorageManager(c),source=await manager.save({kind:'local',path:root});await manager.settle();const id=api.getLibraryPackages()[0].id
  offline=true;manager.action(source.id,'index');await manager.settle();assert.equal(manager.list().sources[0].state,'offline');assert.equal(api.getLibraryPackages()[0].id,id);assert.ok(!JSON.stringify(manager.list()).includes('credential details'))
  offline=false
  const fsp=createRequire(import.meta.url)('node:fs/promises'),oldOpen=fsp.open
  try {
    fsp.open=async(path,...args)=>{if(path===pkg)throw Object.assign(new Error('NAS disconnected'),{code:'EIO'});return oldOpen(path,...args)};syncBuiltinESMExports()
    manager.action(source.id,'rebuild');await manager.settle();assert.equal(manager.list().sources[0].state,'offline');assert.equal(api.getLibraryPackages()[0].id,id,'partial reindex must not erase entries')
  } finally {fsp.open=oldOpen;syncBuiltinESMExports()}
  writeFileSync(join(data,'installation-queue.json'),JSON.stringify({status:'completed',items:[{packageId:id,state:'unconfirmed'}]}))
  await assert.rejects(manager.remove(source.id),e=>e.statusCode===409)
  await assert.rejects(manager.save({...manager.list().sources[0],enabled:false}),e=>e.statusCode===409)
  writeFileSync(join(data,'installation-queue.json'),JSON.stringify({status:'completed',items:[{packageId:id,state:'installed'}]}))
  await manager.remove(source.id);assert.equal(manager.list().sources.length,0);assert.ok(readFileSync(pkg).length);assert.equal(connections,3)
}))

test('encrypted credentials survive restart, blank edits keep passwords, corrupt/missing keys never silently replace secrets; registry has no fixed count limit',()=>context(async(api,work,data)=>{
  let received=''
  const c=connector();c.connect=async(s,p)=>{received=p}
  const manager=api.createStorageManager(c),secret='Storage-secret-$()` ; кириллица'
  const source=await manager.save({kind:'smb',path:'smb://NAS/games',username:'user',password:secret});await manager.settle()
  assert.equal(received,secret);assert.equal(source.hasPassword,true)
  assert.ok(!JSON.stringify(manager.list()).includes(secret));assert.ok(!readFileSync(join(data,'storage-sources.json'),'utf8').includes(secret));assert.ok(!readFileSync(join(data,'storage-secrets.json'),'utf8').includes(secret))
  assert.equal(api.readStoragePassword(source.id),secret)
  const restart=api.createStorageManager(c);await restart.tick();assert.equal(received,secret)
  await restart.save({...restart.list().sources[0],password:''});await restart.settle();assert.equal(api.readStoragePassword(source.id),secret)
  await assert.rejects(restart.save({...restart.list().sources[0],path:'smb://NAS/other'}),e=>e.statusCode===400)
  await assert.rejects(restart.save({kind:'smb',path:'\\\\nas\\games'}),e=>e.statusCode===409)
  const key=readFileSync(join(data,'storage-secrets.key'));unlinkSync(join(data,'storage-secrets.key'))
  assert.throws(()=>api.readStoragePassword(source.id),e=>e.statusCode===503);assert.throws(()=>api.writeStoragePassword(source.id,'replacement'),e=>e.statusCode===503)
  writeFileSync(join(data,'storage-secrets.key'),key);assert.equal(api.readStoragePassword(source.id),secret)
  await restart.save({...restart.list().sources[0],clearPassword:true,password:''});await restart.settle();assert.equal(api.readStoragePassword(source.id),'')
  for(let i=0;i<64;i++)await restart.save({kind:'local',path:join(work,`folder-${i}`),enabled:false})
  assert.equal(restart.list().sources.length,65)
  assert.equal(api.normalizeStoragePath('nfs','nfs://NAS/volume1/games'),'nas:/volume1/games')
  assert.equal(api.mountedStoragePath('abc','nfs','nas:/volume1/games','win32'),'\\\\nfs\\nas\\volume1\\games')
  assert.equal(api.normalizeStoragePath('webdav','https://NAS:5006/games'),'https://nas:5006/games/')
  for(const value of ['https://user:password@nas/games','https://nas/games?password=secret','https://nas/games#secret'])assert.throws(()=>api.normalizeStoragePath('webdav',value))
  assert.throws(()=>api.normalizeStoragePath('smb','//nas/games/../other'));assert.throws(()=>api.normalizeStoragePath('local','relative'))
}))

test('per-source lock and schedule reconnect after restart; scheduled refresh actually runs after repeated connection checks',()=>context(async(api,work,data)=>{
  const root=join(work,'games');mkdirSync(root);writeFileSync(join(root,'one.pkg'),fixture('one'))
  let release,gate,checks=0
  const c=connector();c.connect=async()=>{checks++;if(gate)await gate}
  const manager=api.createStorageManager(c),source=await manager.save({kind:'local',path:root,autoIndex:true,indexIntervalMinutes:5});await manager.settle()
  gate=new Promise(r=>release=r);manager.action(source.id,'index');assert.throws(()=>manager.action(source.id,'connect'),e=>e.statusCode===409);await assert.rejects(manager.remove(source.id),e=>e.statusCode===409);release();gate=undefined;await manager.settle()
  writeFileSync(join(root,'two.pkg'),fixture('two'))
  const file=join(data,'storage-sources.json'),registry=JSON.parse(readFileSync(file,'utf8'))
  registry.sources[0].lastIndexedAt=Date.now()-6*60000;registry.sources[0].lastIndexAttemptAt=Date.now()-6*60000;registry.sources[0].lastCheckedAt=Date.now()-61000;writeFileSync(file,JSON.stringify(registry))
  await manager.tick();assert.equal(api.getLibraryPackages().length,2)
  const before=checks;const restarted=api.createStorageManager(c);await restarted.tick();assert.equal(checks,before+1,'restart reconnects even when last check was recent');assert.equal(api.getLibraryPackages().length,2)
}))

test('native Linux SMB/NFS commands use fixed arguments, read-only mounts and private temporary credentials; foreign mounts are never disconnected',()=>context(async(api,work)=>{
  const cp=createRequire(import.meta.url)('node:child_process'),fsp=createRequire(import.meta.url)('node:fs/promises')
  const oldSpawn=cp.spawn,oldRead=fsp.readFile
  const { EventEmitter }=await import('node:events'),{ PassThrough }=await import('node:stream')
  const dir=join(work,'mount');mkdirSync(dir);const calls=[];let secretOnDisk=false,mounted=''
  try {
    cp.spawn=(file,args)=>{
      calls.push({file,args});const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true
      if(file.endsWith('mount.cifs')) { const credential=args.at(-1).match(/credentials=([^,]+)/)[1];secretOnDisk=readFileSync(credential,'utf8').includes('secret-$()`'); assert.equal(createRequire(import.meta.url)('node:fs').statSync(credential).mode&0o777,0o600);child.once('close',()=>assert.ok(readFileSync(credential).length)) }
      child.stdin.end=()=>queueMicrotask(()=>child.emit('close',0));return child
    }
    fsp.readFile=async(path,...args)=>path==='/proc/mounts'?mounted:oldRead(path,...args);syncBuiltinESMExports()
    const c=api.createStorageConnector({linuxSmb:'cifs'}),source={id:'fixture',kind:'smb',path:'//nas/games/subfolder',localPath:dir,username:'user',domain:'WORKGROUP'}
    await c.connect(source,'secret-$()`');assert.equal(secretOnDisk,true);assert.ok(!JSON.stringify(calls).includes('secret-$()`'));assert.match(calls[0].args.at(-1),/^ro,nosuid,nodev/);assert.match(calls[0].args.at(-1),/prefixpath=subfolder/)
    const credential=calls[0].args.at(-1).match(/credentials=([^,]+)/)[1];assert.ok(!createRequire(import.meta.url)('node:fs').existsSync(credential),'temporary credentials removed')
    await c.connect({...source,kind:'nfs',path:'nas:/volume1/games'},'');assert.equal(calls[1].file,'/usr/sbin/mount.nfs');assert.match(calls[1].args.at(-1),/^ro,nosuid,nodev/)
    mounted=`//foreign/share ${dir} cifs ro 0 0\n`;await assert.rejects(c.disconnect(source),e=>e.statusCode===503);assert.equal(calls.length,2,'foreign mount is not unmounted')
    mounted=`//nas/games ${dir} cifs ro 0 0\n`;await c.disconnect(source);assert.equal(calls[2].file,'/usr/bin/umount');assert.deepEqual(calls[2].args,[dir])
  } finally {cp.spawn=oldSpawn;fsp.readFile=oldRead;syncBuiltinESMExports()}
}))

test('Windows SMB and NFS provider calls send credentials on stdin, never interpolate input into PowerShell or command arguments',()=>context(async(api,work)=>{
  const cp=createRequire(import.meta.url)('node:child_process'),oldSpawn=cp.spawn,fsp=createRequire(import.meta.url)('node:fs/promises'),oldStat=fsp.stat
  const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream'),calls=[]
  try {
    cp.spawn=(file,args)=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true
      child.stdin.end=input=>{calls.push({file,args,input});queueMicrotask(()=>child.emit('close',0))};return child
    };syncBuiltinESMExports()
    const bundle=join(work,'windows.mjs');await build({entryPoints:[resolve('server/utils/storage-connector.ts')],outfile:bundle,bundle:true,platform:'node',format:'esm',logLevel:'silent',define:{'process.platform':'"win32"'}})
    const win=await import(pathToFileURL(bundle).href),c=win.createStorageConnector(),directory=join(work,'share');mkdirSync(directory)
    const secret='secret-$()`',username='user-$()`',source={id:'native-test',kind:'smb',path:'//nas/games/subfolder',localPath:directory,username,domain:'WORKGROUP'}
    await c.connect(source,secret)
    assert.equal(calls[0].file,'powershell.exe');assert.ok(!JSON.stringify(calls[0].args).includes(secret));assert.ok(!JSON.stringify(calls[0].args).includes(username));assert.deepEqual(JSON.parse(calls[0].input),{remote:'\\\\nas\\games',user:`WORKGROUP\\${username}`,password:secret})
    let firstProbe=true
    fsp.stat=async(path,...args)=>{if(path===directory&&firstProbe){firstProbe=false;throw Object.assign(new Error('Not mounted yet'),{code:'ENOENT'})}return oldStat(path,...args)};syncBuiltinESMExports()
    await c.connect({...source,kind:'nfs',path:'nas:/volume1/games',username:'',domain:''},'')
    assert.equal(JSON.parse(calls[1].input).remote,directory);assert.match(calls[1].args.at(-1),/WNetAddConnection2/)
  } finally {cp.spawn=oldSpawn;fsp.stat=oldStat;syncBuiltinESMExports()}
}))

test('desktop Linux SMB uses GIO stdin credentials and a private GVfs link; removal never unmounts shared desktop sessions',()=>context(async(api,work)=>{
  const cp=createRequire(import.meta.url)('node:child_process'),fsp=createRequire(import.meta.url)('node:fs/promises'),oldSpawn=cp.spawn,oldStat=fsp.stat,oldReaddir=fsp.readdir
  const {EventEmitter}=await import('node:events'),{PassThrough}=await import('node:stream'),calls=[]
  const point=join(work,'mounts','source'),target=`/run/user/${process.getuid()}/gvfs/smb-share:server=nas,share=games,user=test/subfolder`
  try {
    cp.spawn=(file,args)=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;child.stdin.end=input=>{calls.push({file,args,input});queueMicrotask(()=>{child.stdout.write(JSON.stringify({path:target}));child.emit('close',0)})};return child}
    fsp.stat=async(path,...args)=>path===point?{isDirectory:()=>true}:oldStat(path,...args);fsp.readdir=async(path,...args)=>path===point?['game.pkg']:oldReaddir(path,...args);syncBuiltinESMExports()
    const c=api.createStorageConnector(),source={id:'desktop',kind:'smb',path:'//nas/games/subfolder',localPath:point,username:'test',domain:''}
    await c.connect(source,'secret-$()`');assert.equal(calls[0].file,'/usr/bin/python3');assert.ok(!JSON.stringify(calls[0].args).includes('secret-$()`'));assert.equal(JSON.parse(calls[0].input).password,'secret-$()`')
    assert.equal(await fsp.readlink(point),target);assert.match(calls[0].args[1],/Gio.PasswordSave.NEVER/)
    await c.disconnect(source);assert.equal(calls.length,1,'no unmount subprocess is launched');await assert.rejects(fsp.lstat(point),e=>e.code==='ENOENT')
  } finally {cp.spawn=oldSpawn;fsp.stat=oldStat;fsp.readdir=oldReaddir;syncBuiltinESMExports()}
}))
