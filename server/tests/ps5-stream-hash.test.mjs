import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, open, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { blake3 } from '@noble/hashes/blake3.js'
const root=await mkdtemp(join(tmpdir(),'pf-stream-source-'));process.env.PACKAGEFLOW_DATA_DIR=join(root,'data')
const mod=join(root,'api.mjs');await build({stdin:{contents:"export * from './server/utils/ps5-stream-hash'; export * from './server/utils/ps5-source-hash'",resolveDir:resolve('.')},outfile:mod,bundle:true,platform:'node',format:'esm',logLevel:'silent'})
const api=await import(pathToFileURL(mod).href),signal=new AbortController().signal
let file
test('source hash resumes from durable checkpoint and reads only the missing prefix tail',async()=>{
 const size=24*1024*1024,source=join(root,'source'),bytes=Buffer.alloc(size,137);await writeFile(source,bytes);file=await open(source,'r')
 const stamp=api.ps5SourceStamp(await file.stat()),id='f'.repeat(32), chunk=4*1024*1024, buffer=Buffer.alloc(chunk)
 let h=await api.ps5StreamHasher(file,root,id,stamp,0,signal)
 for(let p=0;p<20*1024*1024;p+=chunk){await h.read(buffer,p);h.acknowledge(p+chunk)}
 let readBytes=0;const read=file.read.bind(file);file.read=async(...args)=>{const result=await read(...args);readBytes+=result.bytesRead;return result}
 h=await api.ps5StreamHasher(file,root,id,stamp,20*1024*1024,signal)
 assert.equal(readBytes,4*1024*1024,'16 MiB checkpoint avoids rereading the first 16 MiB')
 await h.read(buffer,20*1024*1024);h.acknowledge(size,true)
 assert.equal(h.digest(),Buffer.from(blake3(bytes)).toString('hex'))
 await writeFile(source,Buffer.alloc(size,41));await assert.rejects(h.validate(),/изменился/)
})
test.after(async()=>{await file?.close();await rm(root,{recursive:true,force:true})})
