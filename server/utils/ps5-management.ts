import { createError } from 'h3'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, rmSync, renameSync, createWriteStream, lstatSync, constants } from 'node:fs'
import { open, mkdir } from 'node:fs/promises'
import { resolve, dirname, sep } from 'node:path'
import archiver from 'archiver'
import { createBLAKE3 } from 'hash-wasm'
import { getConsoleProfile, ps5OperationRequest, ps5SaveChunk } from './console-profiles'
import { getLibraryPackages } from './package-library'
import { getPs5Queue } from './ps5-installation-queue'
import { assertNoPs5ServiceUpdate } from './ps5-service-updates'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'

export interface SaveTarget { userId: string; titleId: string; kind: 'native' | 'legacy' }
export interface SaveNode { path: string; fileId: string; directory: boolean; bytes: number }
interface Snapshot { snapshot: string; entries: SaveNode[]; bytes: number }
interface RawBackup { format: 'ps5-encrypted-save-backup-v1'; id: string; consoleId: string; sourceIp: string; userId: string; titleId: string; kind: 'native' | 'legacy'; createdAt: string; snapshot: string; directories: string[]; files: Array<{ path: string; bytes: number; sha256: string }> }
interface Job { id: string; consoleId: string; sourceIp: string; target: SaveTarget; state: 'running' | 'complete' | 'failed'; createdAt: string; bytes: number; total: number; backupId?: string; message?: string }
const idRx = /^[0-9a-f]{32}$/, uuidRx = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const root = () => dataPath('ps5-save-backups'), jobs = () => dataPath('ps5-save-jobs')
const active = new Set<string>(), runners = new Set<string>()
const fail = (message: string) => createError({ statusCode: 409, message })
function profile(id: unknown) { const p = getConsoleProfile(id); if (p.platform !== 'ps5') throw fail('Выберите PS5'); return p }
export function saveTarget(v: any): SaveTarget {
  if (!v || typeof v.userId !== 'string' || !/^[0-9a-f]{8}$/i.test(v.userId) || typeof v.titleId !== 'string' || !/^(PPSA|CUSA)\d{5}$/.test(v.titleId) || !['native','legacy'].includes(v.kind)) throw createError({ statusCode: 400, message: 'Неверный пользователь или игра сохранения PS5' })
  return { userId: v.userId, titleId: v.titleId, kind: v.kind }
}
function headers(target: SaveTarget) { return { 'X-PackageFlow-User': target.userId, 'X-PackageFlow-Title': target.titleId, 'X-PackageFlow-Save-Kind': target.kind } }
export function validateSnapshotPage(v: any, offset: number) {
  if (!v || !/^[a-f0-9]{64}$/.test(v.snapshot) || !Number.isSafeInteger(v.total) || v.total < 0 || v.total > 512 || v.offset !== offset || !Number.isSafeInteger(v.bytes) || v.bytes < 0 || v.bytes > 64 * 1024 ** 3 || !Array.isArray(v.entries) || v.entries.length > 32 || v.next !== offset + v.entries.length || v.next > v.total || v.done !== (v.next === v.total) || !v.done && !v.entries.length) throw fail('PS5 не подтвердила полный состав сохранения')
  for (const n of v.entries) if (!n || typeof n.path !== 'string' || Buffer.byteLength(n.path) > 240 || n.path.split('/').some((p: string) => !p || p === '.' || p === '..' || /[\\\x00-\x1f\x7f]/.test(p)) || !/^[a-f0-9]{64}$/.test(n.fileId) || typeof n.directory !== 'boolean' || !Number.isSafeInteger(n.bytes) || n.bytes < 0 || n.bytes > 64 * 1024 ** 3 || n.directory && n.bytes !== 0) throw fail('Недопустимый файл в составе сохранения')
  return v as { snapshot: string; total: number; bytes: number; next: number; done: boolean; entries: SaveNode[] }
}
async function response(id: string, route: Parameters<typeof ps5OperationRequest>[1], h: Record<string,string> = {}) {
  const r = await ps5OperationRequest(id, route, h)
  if (r.status !== 200) throw fail(r.status === 404 ? 'Обновите службу PS5 для чтения каталога и сохранений' : r.status === 409 ? 'Закройте игру; дождитесь завершения установки или обновления службы' : 'PS5 не подтвердила чтение данных')
  return r.body
}
export async function managementStatus(id: unknown) {
  const p = profile(id), v = await response(p.id, '/api/v1/management/status')
  if (v?.protocol !== 'ps5-management-v1') throw fail('Неизвестный протокол службы PS5')
  return { consoleId: p.id, ready: v.ready === true, catalog: v.catalog === true, savesList: v.savesList === true, savesBackup: v.savesBackup === true, savesRestore: v.savesRestore === true, consoleGames: v.consoleGames === true, consoleControl: v.consoleControl === true, consoleSourceControl: v.consoleSourceControl === undefined ? v.consoleControl === true : v.consoleSourceControl === true, consoleUnpack: v.consoleUnpack === true, consoleActivity: v.consoleActivity === true }
}
async function ready(id: string, operation: 'catalog' | 'savesList' | 'savesBackup' | 'savesRestore') { const v = await managementStatus(id); if (!v.ready || !v[operation]) throw fail('Эта возможность службы PS5 ещё не подтверждена испытанием'); return v }
function names(id: string) { const p = profile(id); return getLibraryPackages(p.ip) }
export async function consoleCatalog(id: unknown) {
  const p = profile(id); await ready(p.id, 'catalog'); const library = names(p.id), entries: any[] = [], seen = new Set<string>(); let offset = 0, revision: string | undefined
  for (let i = 0; i < 4096; i++) {
    const v = await response(p.id, '/api/v1/console/catalog', { 'X-PackageFlow-Offset': String(offset) })
    if (!/^[a-f0-9]{64}$/.test(v.revision) || revision !== undefined && revision !== v.revision || !Array.isArray(v.entries) || v.entries.length > 1 || v.next !== offset + v.entries.length || typeof v.done !== 'boolean' || !v.done && !v.entries.length) throw fail('Неполный ответ каталога PS5')
    revision = v.revision
    for (const row of v.entries) {
      if (!/^(PPSA|CUSA)\d{5}$/.test(row.titleId) || typeof row.contentId !== 'string' || row.contentId.length > 128 || typeof row.metadata !== 'string' || row.metadata.length > 32768) throw fail('Неверная запись каталога PS5')
      const key = `${row.titleId}/${row.contentId}`; if (seen.has(key)) throw fail('Каталог изменился; обновите его'); seen.add(key)
      let info: any = {}; try { info = JSON.parse(row.metadata) } catch { /* Missing metadata never invents a version. */ }
      const source = library.find(item => item.titleId === row.titleId && item.type === 'Игра')
      const localized = info?.localizedParameters; const title = info?.TITLE || info?.titleName || localized?.['ru-RU']?.titleName || localized?.['en-US']?.titleName
      entries.push({ titleId: row.titleId, contentId: row.contentId, title: typeof title === 'string' ? title.slice(0, 256) : source?.title || row.titleId, version: typeof (info?.CONTENT_VERSION || info?.contentVersion) === 'string' ? (info.CONTENT_VERSION || info.contentVersion).slice(0,32) : '', platform: row.titleId.startsWith('PPSA') ? 'ps5' : 'ps4', registered: true, cover: source?.iconSize ? `/api/packages/${source.id}?asset=icon` : undefined })
    }
    offset = v.next; if (v.done) return { consoleId: p.id, complete: true, entries }
  }
  throw fail('Каталог превышает допустимый объём; неполный список не показан')
}
export async function listPs5Saves(id: unknown) {
  const p = profile(id); await ready(p.id, 'savesList'); const library = names(p.id), entries: any[] = [], seen = new Set<string>(); let offset = 0, total: number | undefined, revision: string | undefined
  for (let i = 0; i < 4096; i++) {
    const v = await response(p.id, '/api/v1/saves/list', { 'X-PackageFlow-Offset': String(offset) })
    if (!/^[a-f0-9]{64}$/.test(v.revision) || revision !== undefined && revision !== v.revision || !Array.isArray(v.entries) || v.entries.length > 1 || !Number.isSafeInteger(v.total) || v.total < 0 || v.total > 4096 || total !== undefined && total !== v.total || v.next !== offset + v.entries.length || v.next > v.total || v.done !== (v.next === v.total) || !v.done && !v.entries.length) throw fail('Список сохранений изменился; обновите его')
    revision = v.revision; total = v.total; for (const row of v.entries) { const target = saveTarget(row); const key = JSON.stringify(target); if (seen.has(key)) throw fail('Список сохранений изменился; обновите его'); seen.add(key); entries.push({ ...target, title: library.find(item => item.titleId === target.titleId && item.type === 'Игра')?.title || target.titleId }) }
    offset = v.next; if (v.done) return { consoleId: p.id, complete: true, entries }
  }
  throw fail('Список сохранений превышает допустимый объём')
}
async function snapshot(id: string, target: SaveTarget): Promise<Snapshot> {
  const entries: SaveNode[] = []; const seen = new Set<string>(); let offset = 0, first: any
  for (let i = 0; i < 17; i++) {
    const v = validateSnapshotPage(await response(id, '/api/v1/saves/manifest', { ...headers(target), 'X-PackageFlow-Offset': String(offset) }), offset)
    if (first && (first.snapshot !== v.snapshot || first.bytes !== v.bytes || first.total !== v.total)) throw fail('Сохранение изменилось во время проверки')
    first ||= v; for (const row of v.entries) { if (seen.has(row.path)) throw fail('Повторный путь в сохранении'); seen.add(row.path); entries.push(row) }
    offset = v.next; if (v.done) { if (entries.filter(row => !row.directory).reduce((sum,row) => sum + row.bytes,0) !== v.bytes) throw fail('Размер состава сохранения не совпал'); return { snapshot: v.snapshot, bytes: v.bytes, entries } }
  }
  throw fail('Неполный состав сохранения')
}
function jobPath(id: string) { if (!idRx.test(id)) throw fail('Неверный номер задания'); return resolve(jobs(), `${id}.json`) }
function readJob(consoleId: unknown, id: string): Job {
  const p = profile(consoleId); let job: Job; try { job = JSON.parse(readFileSync(jobPath(id),'utf8')) } catch { throw fail('Задание копирования не найдено') }
  if (job.id !== id || job.consoleId !== p.id || job.sourceIp !== p.ip || !['running','complete','failed'].includes(job.state)) throw fail('Задание относится к другой приставке')
  saveTarget(job.target)
  if (job.state === 'running' && !runners.has(id)) { job.state = 'failed'; job.message = 'WEB был перезапущен; незавершённая копия не опубликована'; writeDurableJson(jobPath(id),job) }
  return job
}
export function listPs5BackupJobs(consoleId: unknown) { const p=profile(consoleId); if(!existsSync(jobs()))return [];return readdirSync(jobs()).filter(name=>/^[0-9a-f]{32}\.json$/.test(name)).flatMap(name=>{try{return [readJob(p.id,name.slice(0,-5))]}catch{return []}}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50) }
export function ps5BackupJob(consoleId: unknown, id: string) { return readJob(consoleId,id) }
async function runBackup(job: Job) {
  const backupId = randomUUID(), temporary = resolve(root(),`.partial-${backupId}`), destination = resolve(root(),backupId)
  try {
    await ready(job.consoleId, 'savesBackup'); assertNoPs5ServiceUpdate(job.consoleId)
    if (getPs5Queue(job.consoleId).items.some(item => !['installed','failed','skipped','cancelled'].includes(item.state))) throw fail('Дождитесь окончания очереди PS5')
    const before = await snapshot(job.consoleId,job.target)
    if (!before.entries.some(row => !row.directory)) throw fail('В этой папке сохранения нет файлов')
    job.total = before.bytes; writeDurableJson(jobPath(job.id),job); await mkdir(resolve(temporary,'files'),{recursive:true,mode:0o700})
    const manifest: RawBackup = { format:'ps5-encrypted-save-backup-v1',id:backupId,consoleId:job.consoleId,sourceIp:job.sourceIp,...job.target,createdAt:new Date().toISOString(),snapshot:before.snapshot,directories:[],files:[] }
    let checkpoint=0
    for (const row of before.entries) {
      if (profile(job.consoleId).ip !== job.sourceIp) throw fail('Приставка изменилась')
      const path = resolve(temporary,'files',row.path)
      if (row.directory) { await mkdir(path,{recursive:true,mode:0o700}); manifest.directories.push(row.path); continue }
      await mkdir(dirname(path),{recursive:true,mode:0o700}); const fd = await open(path,'wx',0o600), hash=createHash('sha256')
      try {
        let offset=0
        do {
          const size=Math.min(1048576,row.bytes-offset), data=await ps5SaveChunk(job.consoleId,{...headers(job.target),'X-PackageFlow-Save-Path':Buffer.from(row.path).toString('hex'),'X-PackageFlow-File-Id':row.fileId,'X-PackageFlow-Offset':String(offset),'X-PackageFlow-Size':String(size)})
          let written=0; while(written<data.length){const n=await fd.write(data,written,data.length-written);if(!n.bytesWritten)throw Error('Short save write');written+=n.bytesWritten}
          hash.update(data);offset+=data.length;job.bytes+=data.length
          if(Date.now()-checkpoint>1000){writeDurableJson(jobPath(job.id),job);checkpoint=Date.now()}
        } while(offset<row.bytes)
        await fd.sync()
      } finally { await fd.close() }
      manifest.files.push({path:row.path,bytes:row.bytes,sha256:hash.digest('hex')})
    }
    const after=await snapshot(job.consoleId,job.target)
    if (before.snapshot!==after.snapshot || JSON.stringify(before.entries)!==JSON.stringify(after.entries) || job.bytes!==before.bytes) throw fail('Источник изменился; копия не опубликована')
    writeDurableJson(resolve(temporary,'metadata.json'),manifest); renameSync(temporary,destination)
    job.state='complete';job.backupId=backupId;writeDurableJson(jobPath(job.id),job)
  } catch (e:any) { job.state='failed';job.message=e?.data?.message || e?.message || 'Не удалось создать копию';rmSync(temporary,{recursive:true,force:true});try{writeDurableJson(jobPath(job.id),job)}catch{console.error('PS5 backup result could not be persisted; no command replay')} }
  finally { active.delete(job.consoleId);runners.delete(job.id) }
}
export function startPs5Backup(consoleId: unknown, input: unknown, requestId: unknown) {
  const p=profile(consoleId),target=saveTarget(input)
  if (typeof requestId!=='string' || !idRx.test(requestId)) throw fail('Нужен идентификатор команды копирования')
  if (existsSync(jobPath(requestId))) { const old=readJob(p.id,requestId);if(JSON.stringify(old.target)!==JSON.stringify(target))throw fail('Этот идентификатор относится к другому сохранению');return old }
  if(active.has(p.id)||pendingRestore(p.id))throw fail('Для этой PS5 уже выполняется копирование или восстановление')
  const job:Job={id:requestId,consoleId:p.id,sourceIp:p.ip,target,state:'running',createdAt:new Date().toISOString(),bytes:0,total:0}
  writeDurableJson(jobPath(job.id),job);active.add(p.id);runners.add(job.id);void runBackup(job);return job
}
function readBackup(consoleId: unknown,id: string) {
  const p=profile(consoleId);if(!uuidRx.test(id))throw fail('Неверный номер копии');const directory=resolve(root(),id);let m:RawBackup
  try {for (const path of [directory, resolve(directory,'files')]) {const st=lstatSync(path);if(!st.isDirectory()||st.isSymbolicLink())throw Error('Invalid backup root')} const st=lstatSync(resolve(directory,'metadata.json'));if(!st.isFile()||st.isSymbolicLink()||st.size>1048576)throw Error('Invalid manifest');m=JSON.parse(readFileSync(resolve(directory,'metadata.json'),'utf8'))}catch{throw fail('Копия не найдена')}
  if(typeof m.createdAt!=='string'||!Number.isFinite(Date.parse(m.createdAt))||!/^[a-f0-9]{64}$/.test(m.snapshot)||m.format!=='ps5-encrypted-save-backup-v1'||m.id!==id||m.consoleId!==p.id||m.sourceIp!==p.ip||!Array.isArray(m.files)||!Array.isArray(m.directories)||m.files.length+m.directories.length>512||!m.files.length)throw fail('Копия относится к другой приставке или повреждена')
  saveTarget(m);const seen=new Set<string>();let bytes=0
  for(const [path,directory] of [...m.directories.map(path=>[path,true] as const),...m.files.map(file=>[file.path,false] as const)]){
    if(typeof path!=='string'||Buffer.byteLength(path)>240||path.split('/').some(part=>!part||part==='.'||part==='..'||/[\\\x00-\x1f\x7f]/.test(part))||seen.has(path))throw fail('Повреждён путь в копии');seen.add(path)
    let current=resolve(root(),id,'files');for(const part of path.split('/')){current=resolve(current,part);if(!current.startsWith(resolve(root(),id,'files')+sep)||lstatSync(current).isSymbolicLink())throw fail('Недопустимая ссылка в копии')}
    if(directory?!lstatSync(current).isDirectory():!lstatSync(current).isFile())throw fail('Файл копии отсутствует')
  }
  for(const f of m.files){if(!Number.isSafeInteger(f.bytes)||f.bytes<0||! /^[a-f0-9]{64}$/.test(f.sha256))throw fail('Повреждён манифест копии');bytes+=f.bytes;if(bytes>64*1024**3)throw fail('Недопустимый размер копии')}
  return {directory,manifest:m,bytes}
}
export function listPs5Backups(consoleId: unknown) {
  const p=profile(consoleId);if(!existsSync(root()))return []
  return readdirSync(root()).filter(id=>uuidRx.test(id)).flatMap(id=>{try{const b=readBackup(p.id,id);return [{id,...saveTarget(b.manifest),createdAt:b.manifest.createdAt,bytes:b.bytes,files:b.manifest.files.length}]}catch{return []}}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
}
const archives=new Map<string,Promise<any>>()
export async function ps5BackupArchive(consoleId: unknown,id: string) {
  const b=readBackup(consoleId,id), key=`${b.manifest.consoleId}/${id}`
  if(archives.has(key))return archives.get(key)!
  const operation=(async()=>{
    for(const f of b.manifest.files){const fd=await open(resolve(b.directory,'files',f.path),'r'),hash=createHash('sha256');let bytes=0;try{for await(const data of fd.createReadStream({autoClose:false})){hash.update(data);bytes+=data.length}}finally{await fd.close()}if(bytes!==f.bytes||hash.digest('hex')!==f.sha256)throw fail('Контрольная сумма копии не совпала')}
    const archivePath=resolve(b.directory,'backup.zip')
    if(existsSync(archivePath)){const st=lstatSync(archivePath);if(!st.isFile()||st.isSymbolicLink())throw fail('Недопустимый архив')}
    {
      const temp=resolve(b.directory,`.zip-${randomUUID()}.tmp`),output=createWriteStream(temp,{flags:'wx',mode:0o600}),zip=archiver('zip',{zlib:{level:0}})
      const finished=new Promise<void>((resolve,reject)=>{output.on('close',resolve);output.on('error',reject);zip.on('error',reject)})
      try{zip.pipe(output);zip.file(resolve(b.directory,'metadata.json'),{name:'metadata.json'});for(const d of b.manifest.directories)zip.append('',{name:`files/${d}/`});for(const f of b.manifest.files)zip.file(resolve(b.directory,'files',f.path),{name:`files/${f.path}`});await Promise.all([zip.finalize(),finished]);renameSync(temp,archivePath)}catch(e){zip.abort();output.destroy();rmSync(temp,{force:true});throw e}
    }
    return {...b,archivePath,size:lstatSync(archivePath).size}
  })();archives.set(key,operation);try{return await operation}finally{archives.delete(key)}
}

export interface RestoreJob {
  id:string;consoleId:string;sourceIp:string;backupId:string;target:SaveTarget;createdAt:string;
  state:'checking'|'uploading'|'applying'|'pending'|'uncertain'|'confirmed'|'rolled-back'|'failed';
  bytes:number;checked:number;total:number;message?:string;applyIntent?:boolean;
  receipt?:any;transfers?:Array<{path:string;id:string;hash:string;bytes:number}>;
}
const restores=()=>dataPath('ps5-save-restores'),restoreRunners=new Set<string>()
function restorePath(id:string){if(!idRx.test(id))throw fail('Неверный номер восстановления');return resolve(restores(),`${id}.json`)}
function readRestore(consoleId:unknown,id:string):RestoreJob{
  const p=profile(consoleId);let job:RestoreJob
  try{job=JSON.parse(readFileSync(restorePath(id),'utf8'))}catch{throw fail('Задание восстановления не найдено')}
  if(job.id!==id||job.consoleId!==p.id||job.sourceIp!==p.ip||!uuidRx.test(job.backupId)||!['checking','uploading','applying','pending','uncertain','confirmed','rolled-back','failed'].includes(job.state))throw fail('Задание относится к другой приставке или повреждено')
  saveTarget(job.target)
  if(['checking','uploading','applying'].includes(job.state)&&!restoreRunners.has(job.id)){job.state=job.applyIntent?'uncertain':'failed';job.message=job.applyIntent?'WEB перезапущен: проверяем сохранённый результат PS5 без повторной команды':'WEB перезапущен до применения копии; сохранение не заменялось';writeDurableJson(restorePath(job.id),job)}
  return job
}
function publicRestore(job:RestoreJob){const {transfers,...visible}=job;return visible}
export function listPs5Restores(consoleId:unknown){const p=profile(consoleId);if(!existsSync(restores()))return[];return readdirSync(restores()).filter(n=>/^[0-9a-f]{32}\.json$/.test(n)).flatMap(n=>{try{return[publicRestore(readRestore(p.id,n.slice(0,-5)))]}catch{return[]}}).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).slice(0,50)}
function pendingRestore(consoleId:string){return listPs5Restores(consoleId).some(j=>!['confirmed','rolled-back','failed'].includes(j.state))}
export function buildPs5RestoreManifest(target:SaveTarget,current:Snapshot,copy:RawBackup,transfers:NonNullable<RestoreJob['transfers']>){
  if(JSON.stringify(saveTarget(copy))!==JSON.stringify(saveTarget(target)))throw fail('Копия относится к другому пользователю или игре');
  const layout=(nodes:Array<{path:string;directory:boolean}>)=>nodes.map(n=>`${n.directory?'D':'F'} ${n.path}`).sort()
  const source=[...copy.directories.map(path=>({path,directory:true})),...copy.files.map(f=>({path:f.path,directory:false}))]
  if(JSON.stringify(layout(current.entries))!==JSON.stringify(layout(source))||source.some(n=>n.path.split('/').some(p=>p.startsWith('.pf-')))||transfers.length!==copy.files.length||new Set(transfers.map(f=>f.id)).size!==transfers.length)throw fail('Состав копии отличается от сохранения на PS5. Восстановление допускается в существующие слоты этой игры.')
  for(const f of copy.files){const transfer=transfers.find(t=>t.path===f.path);if(!transfer||!idRx.test(transfer.id)||!/^[a-f0-9]{64}$/.test(transfer.hash)||transfer.bytes!==f.bytes)throw fail('Неполный план восстановления')}
  const text=`PFSAVERESTORE1 ${target.userId} ${target.titleId} ${target.kind} ${current.snapshot} ${source.length}\n`+copy.directories.map(path=>`D ${Buffer.from(path).toString('hex')}\n`).join('')+transfers.map(f=>`F ${f.id} ${f.hash} ${f.bytes} ${Buffer.from(f.path).toString('hex')}\n`).join('')
  if(Buffer.byteLength(text)>262143)throw fail('Манифест восстановления превышает лимит службы');return text
}
async function restoreUpload(job:RestoreJob,file:NonNullable<RestoreJob['transfers']>[number],fd:Awaited<ReturnType<typeof open>>){
  const h={'X-PackageFlow-Transfer-Id':file.id,'X-PackageFlow-Size':String(file.bytes),'X-PackageFlow-Blake3':file.hash}
  let v=await response(job.consoleId,'/api/v1/transfers/begin',h)
  const proof=(v:any)=>{if(v.id!==file.id||v.size!==file.bytes||v.blake3!==file.hash||!Number.isSafeInteger(v.bytesDurable)||v.bytesDurable<0||v.bytesDurable>file.bytes||v.cancelled!==false)throw fail('PS5 не подтвердила файл восстановления')}
  proof(v);let at=v.bytesDurable
  while(at<file.bytes){const size=Math.min(1048576,file.bytes-at),b=Buffer.alloc(size),got=await fd.read(b,0,size,at);if(got.bytesRead!==size)throw fail('Копия изменилась при передаче');const r=await ps5OperationRequest(job.consoleId,'/api/v1/transfers/chunk',{...h,'X-PackageFlow-Offset':String(at)},b);if(r.status!==200)throw fail('Передача копии на PS5 прервана');v=r.body;proof(v);if(v.bytesDurable!==at+size)throw fail('Неверное подтверждение передачи');at=v.bytesDurable;job.bytes+=size;writeDurableJson(restorePath(job.id),job)}
  const commit=await ps5OperationRequest(job.consoleId,'/api/v1/transfers/commit',h)
  if(commit.status!==200&&commit.status!==202)throw fail('PS5 не смогла проверить файл копии')
  for(let i=0;i<600;i++){v=await response(job.consoleId,'/api/v1/transfers/status',{'X-PackageFlow-Transfer-Id':file.id});proof(v);if(v.verified===true&&v.bytesDurable===file.bytes)return;await new Promise(r=>setTimeout(r,1000))}
  throw fail('Проверка файла копии не завершена; восстановление не применено')
}
function saveRestoreReceipt(job:RestoreJob,v:any){if(v?.requestId!==job.id||v.userId!==job.target.userId||v.titleId!==job.target.titleId||v.kind!==job.target.kind||!['preparing','applying','pending','finalizing','finalized','rolled-back','failed'].includes(v.state))throw fail('Результат PS5 не соответствует восстановлению');job.receipt=v;job.state=v.state==='finalized'?'confirmed':v.state==='rolled-back'?'rolled-back':v.state==='failed'?'failed':v.state==='pending'?'pending':'uncertain';job.message=undefined;writeDurableJson(restorePath(job.id),job);return publicRestore(job)}
async function runRestore(job:RestoreJob){
  try{
    await ready(job.consoleId,'savesRestore');assertNoPs5ServiceUpdate(job.consoleId)
    if(getPs5Queue(job.consoleId).items.some(i=>!['installed','failed','skipped','cancelled'].includes(i.state)))throw fail('Дождитесь окончания очереди PS5')
    const copy=readBackup(job.consoleId,job.backupId),current=await snapshot(job.consoleId,job.target)
    job.total=copy.bytes;job.transfers=[]
    for(const f of copy.manifest.files){
      const fd=await open(resolve(copy.directory,'files',f.path),constants.O_RDONLY|constants.O_NOFOLLOW),sha=createHash('sha256'),b3=await createBLAKE3(256);b3.init();let bytes=0
      try{const before=await fd.stat();if(!before.isFile()||before.nlink!==1||before.size!==f.bytes)throw fail('Файл копии изменился');for await(const data of fd.createReadStream({autoClose:false})){sha.update(data);b3.update(data);bytes+=data.length;job.checked+=data.length}const after=await fd.stat();if(before.ino!==after.ino||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||bytes!==f.bytes||sha.digest('hex')!==f.sha256)throw fail('Контрольная сумма копии не совпала')}finally{await fd.close()}
      job.transfers.push({path:f.path,id:randomUUID().replaceAll('-',''),hash:b3.digest('hex'),bytes:f.bytes});writeDurableJson(restorePath(job.id),job)
    }
    buildPs5RestoreManifest(job.target,current,copy.manifest,job.transfers)
    job.state='uploading';writeDurableJson(restorePath(job.id),job)
    for(const f of job.transfers){if(profile(job.consoleId).ip!==job.sourceIp)throw fail('Приставка изменилась');const fd=await open(resolve(copy.directory,'files',f.path),constants.O_RDONLY|constants.O_NOFOLLOW);try{await restoreUpload(job,f,fd)}finally{await fd.close()}}
    const beforeApply=await snapshot(job.consoleId,job.target);if(beforeApply.snapshot!==current.snapshot)throw fail('Сохранение изменилось во время передачи; копия не применена')
    const body=Buffer.from(buildPs5RestoreManifest(job.target,beforeApply,copy.manifest,job.transfers));job.state='applying';job.applyIntent=true;writeDurableJson(restorePath(job.id),job)
    const r=await ps5OperationRequest(job.consoleId,'/api/v1/saves/restore',{...headers(job.target),'X-PackageFlow-Request-Id':job.id},body)
    if(r.status===200)saveRestoreReceipt(job,r.body)
    else if(r.body?.state==='rolled-back')saveRestoreReceipt(job,r.body)
    else throw fail(`Восстановление не подтверждено (${r.status}); проверяем журнал PS5`)
  }catch(e:any){job.state=job.applyIntent?'uncertain':'failed';job.message=e?.data?.message||e?.message||'Не удалось восстановить копию';writeDurableJson(restorePath(job.id),job)}
  finally{active.delete(job.consoleId);restoreRunners.delete(job.id)}
}
export function startPs5Restore(consoleId:unknown,backupId:string,requestId:string,confirmTitleId:string){
  const p=profile(consoleId),b=readBackup(p.id,backupId);if(!idRx.test(requestId)||confirmTitleId!==b.manifest.titleId)throw fail('Подтвердите восстановление вводом Title ID')
  if(existsSync(restorePath(requestId))){const old=readRestore(p.id,requestId);if(old.backupId!==backupId)throw fail('Этот номер относится к другой копии');return publicRestore(old)}
  if(active.has(p.id)||pendingRestore(p.id))throw fail('Для этой PS5 уже выполняется копирование или восстановление')
  const job:RestoreJob={id:requestId,consoleId:p.id,sourceIp:p.ip,backupId,target:saveTarget(b.manifest),createdAt:new Date().toISOString(),state:'checking',bytes:0,checked:0,total:b.bytes}
  writeDurableJson(restorePath(requestId),job);active.add(p.id);restoreRunners.add(job.id);void runRestore(job);return publicRestore(job)
}
export async function ps5RestoreJob(consoleId:unknown,requestId:string){const job=readRestore(consoleId,requestId);if(job.state==='uncertain'){try{const r=await ps5OperationRequest(job.consoleId,'/api/v1/saves/restore/status',{'X-PackageFlow-Request-Id':job.id});if(r.status===200)return saveRestoreReceipt(job,r.body);if(r.status===404){job.message='PS5 не нашла запись применения. Не отправляем команду повторно; требуется сверка.';writeDurableJson(restorePath(job.id),job)}}catch{/* Only read reconciliation; never reapply. */}}return publicRestore(job)}
export async function finishPs5Restore(consoleId:unknown,requestId:string,action:'rollback'|'finalize',confirmTitleId:string){
  const job=readRestore(consoleId,requestId);if(!['rollback','finalize'].includes(action)||job.target.titleId!==confirmTitleId)throw fail('Подтвердите действие вводом Title ID')
  if(job.state===(action==='rollback'?'rolled-back':'confirmed'))return publicRestore(job)
  if(!['pending','uncertain'].includes(job.state))throw fail('Сначала дождитесь результата восстановления')
  if(active.has(job.consoleId))throw fail('Для этой PS5 выполняется копирование');assertNoPs5ServiceUpdate(job.consoleId)
  if(getPs5Queue(job.consoleId).items.some(i=>!['installed','failed','skipped','cancelled'].includes(i.state)))throw fail('Дождитесь окончания очереди PS5')
  active.add(job.consoleId);try{const r=await ps5OperationRequest(job.consoleId,action==='rollback'?'/api/v1/saves/rollback':'/api/v1/saves/finalize',{...headers(job.target),'X-PackageFlow-Request-Id':job.id});if(r.status!==200)throw fail(`PS5 не завершила действие (${r.status}). Закройте игру и проверьте результат.`);return saveRestoreReceipt(job,r.body)}finally{active.delete(job.consoleId)}
}
