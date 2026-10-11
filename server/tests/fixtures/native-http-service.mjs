// Synthetic console replies for the real Nuxt HTTP integration test. This
// preload runs only in its child server with an isolated PACKAGEFLOW_DATA_DIR.
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
const dir=process.env.PACKAGEFLOW_DATA_DIR
if(!dir?.includes('pf-native-http-'))throw new Error('Refuse non-fixture data directory')
const original=globalThis.fetch
const file=join(dir,'fixture-state.json'),trace=join(dir,'fixture-trace.jsonl')
const json=value=>new Response(JSON.stringify(value),{headers:{'Content-Type':'application/json'}})
globalThis.fetch=async(input,options={})=>{
  const url=new URL(input instanceof Request?input.url:input),path=url.pathname
  if(['127.0.0.1','localhost'].includes(url.hostname))return original(input,options)
  if(!['192.168.50.4','192.168.50.5','192.168.50.6'].includes(url.hostname))throw new Error('No external connections in native HTTP fixture')
  const state=JSON.parse(readFileSync(file,'utf8')),save=()=>writeFileSync(file,JSON.stringify(state))
  const report={host:url.hostname,path,method:options.method||'GET'}
  if(options.method==='POST')appendFileSync(trace,JSON.stringify(report)+'\n')
  if(url.hostname==='192.168.50.5'){
    const service='PackageFlowService-PS5'
    if(path==='/health')return json({apiVersion:'v1',firmwareRead:true,firmwareRaw:'0x13600007',serviceReport:{service,platform:'ps5',consoleVerified:true}})
    if(path==='/api/v1/capabilities')return json({service,capabilities:{backgroundService:true}})
    if(path==='/api/v1/install/readiness')return json({service,schemaVersion:1,route:'staged-pkg',ready:true,reason:'ready',formats:['pkg'],platforms:['ps4','ps5'],exactVersionReceipt:false})
    if(path==='/api/v1/system')return json({service,storageRead:true,freeBytes:8*1024**3,totalBytes:10*1024**3})
    if(path==='/api/v1/management/status')return json({protocol:'ps5-management-v1',ready:true,catalog:true})
    if(path==='/api/v1/console/catalog')return json({revision:'a'.repeat(64),entries:state.five.map(row=>({titleId:row.title_id,contentId:row.content_id,metadata:JSON.stringify({contentVersion:row.version})})),next:state.five.length,done:true})
    if(path==='/api/v1/console/info')return json(state.five.find(row=>row.title_id===options.headers['X-PackageFlow-Title']))
    throw new Error('Unexpected PS5 fixture operation: '+path)
  }
  const service='PackegeFlowService',inventory=state.inventory[url.hostname]||{}
  const cap={service,version:'test',installApi:1,authentication:'bearer',ready:true,contentTypes:['PS4GD','PS4GP','PS4AC']}
  if(path==='/ping')return json({service,status:'ok',version:'test'})
  if(path==='/install/capabilities'||path==='/install/session')return json(cap)
  if(path==='/system/info')return json({...cap,environment:'ps4',pkgVersion:'test',firmware:{version:'9.00'},model:{name:'Fixture'},hen:{name:'Fixture'}})
  if(path==='/storage')return json({...cap,volumes:[{id:'internal',path:'/user',available:true,availableBytes:8*1024**3,freeBytes:8*1024**3,totalBytes:10*1024**3,usedBytes:2*1024**3}]})
  if(path==='/status')return json({...cap,status:'ok',uptimeSeconds:1,requests:1,replies:1})
  if(path.startsWith('/apps/title/')){
    const titleId=path.split('/').at(-1),parts=inventory[titleId]||[],offset=Number(url.searchParams.get('offset')||0)
    return json({service,complete:true,revision:'a'.repeat(16),app:{titleId,title:titleId,version:'01.00',installed:!!parts.length,protected:false},components:parts.slice(offset,offset+8),total:parts.length,next:offset+8<parts.length?offset+8:null})
  }
  if(path.startsWith('/apps/runtime/'))return json({service,titleId:path.split('/').at(-1),running:false,appId:-1})
  if(path==='/apps/remove'){
    const body=JSON.parse(options.body),parts=inventory[body.titleId]||[],affected=parts.filter(row=>body.kind==='game'||row.kind===body.kind&&row.id===body.componentId)
    if(!affected.length)throw new Error('Fixture removal has no target')
    inventory[body.titleId]=parts.filter(row=>!affected.includes(row))
    const result={service,...body,state:'removed',completed:affected.length,total:affected.length,error:0,errorHex:'0x00000000',pollError:0}
    state.removals[body.requestId]=result;save();return json(result)
  }
  if(path.startsWith('/apps/operations/'))return json(state.removals[path.split('/').at(-1)])
  if(path==='/install/jobs/active')return json({service,active:false})
  if(path==='/install/jobs'){
    const body=JSON.parse(options.body)
    inventory[body.titleId]=[{id:'base',kind:'base',title:body.title,version:'01.00',contentId:body.contentId,sizeBytes:body.size,storage:'internal',canRemove:true}]
    const result={service,jobId:body.requestId,requestId:body.requestId,contentId:body.contentId,taskId:43,state:'installed',totalBytes:body.size,downloadedBytes:body.size,downloadTotalBytes:body.size,error:0,errorHex:'0x00000000',pollError:0}
    state.jobs[body.requestId]=result;save();return json(result)
  }
  if(path.startsWith('/install/jobs/'))return json(state.jobs[path.split('/').at(-1)])
  throw new Error('Unexpected PS4 fixture operation: '+path)
}
