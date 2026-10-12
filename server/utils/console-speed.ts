import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { dataPath } from './data-path'
import { writeDurableJson } from './durable-json'
import { createError } from 'h3'
import { getConsoleProfile, ps5OperationRequest, ps5SpeedRequest } from './console-profiles'
import { getPs5Queue } from './ps5-installation-queue'
import { assertNoPs5ServiceUpdate } from './ps5-service-updates'
import { assertNoPs5Bootstrap } from './ps5-bootstrap-journal'
import { acquireConsoleSpeedTest } from './console-speed-lock'
import type { ConsoleSpeedJob, SpeedMode } from '../../shared/types/console-speed'
const jobs = new Map<string, { job: ConsoleSpeedJob; controller: AbortController }>()
function lastResult(consoleId: string): ConsoleSpeedJob | undefined {
  const live = jobs.get(consoleId)?.job
  if (live) return structuredClone(live)
  const path = dataPath(`consoles/${consoleId}/speed-result.json`)
  if (!existsSync(path)) return
  try { const job = JSON.parse(readFileSync(path, 'utf8')); if (job.consoleId === consoleId && typeof job.id === 'string' && ['completed','failed','cancelled'].includes(job.state) && Array.isArray(job.results)) return job } catch {}
}
export function consoleSpeedJob(consoleId: string, id: string) {
  getConsoleProfile(consoleId); const value = lastResult(consoleId)
  if (!value || value.id !== id) throw createError({ statusCode: 404, message: 'Тест не найден.' })
  return value
}
export async function consoleSpeedInfo(consoleId: string) {
  const p = getConsoleProfile(consoleId)
  if (p.platform !== 'ps5') return { ready: false, message: 'Для PS4 требуется обновление службы с поддержкой тестов скорости.' }
  const q=getPs5Queue(consoleId), queue={queueStatus:q.status,queueId:q.id,lastJob:lastResult(consoleId)}
  try { const r = await ps5OperationRequest(consoleId, '/api/v1/benchmark/info'); return { ...queue, ready: r.status === 200 && r.body.protocol === 'speed-test-v1' && r.body.ready === true, message: r.status === 409 ? 'PS5 завершает другую операцию. Обновите проверку через несколько секунд.' : r.status === 200 ? (r.body.ready ? '' : 'Тесты ещё не проверены для этой нагрузки.') : 'Обновите ELF: он пока не поддерживает тесты скорости.' } }
  catch { return { ...queue, ready: false, message: 'Не удалось подключиться к ELF. Проверьте подключение приставки.' } }
}
export async function beginConsoleSpeed(consoleId: string, sizeMiB: unknown, modes: unknown) {
  const p = getConsoleProfile(consoleId)
  if (p.platform !== 'ps5' || ![64,128,256].includes(Number(sizeMiB)) || !Array.isArray(modes) || !modes.length || modes.length > 4 || new Set(modes).size !== modes.length || modes.some(mode => !['latency','upload','download','disk'].includes(mode))) throw createError({ statusCode: 400, message: 'Выберите поддерживаемые тесты и размер.' })
  const q = getPs5Queue(consoleId)
  if (q.status === 'running' || q.items.some(item => item.installDispatched && !['installed','failed','cancelled','skipped'].includes(item.state))) throw createError({ statusCode: 409, message: 'Сначала приостановите передачу или дождитесь установки. Одновременный тест исказит скорость.' })
  assertNoPs5ServiceUpdate(consoleId); assertNoPs5Bootstrap(consoleId)
  const release = acquireConsoleSpeedTest(consoleId)
  try {
    const info = await consoleSpeedInfo(consoleId)
    if (!info.ready) throw createError({ statusCode: 409, message: info.message })
    const op = await ps5OperationRequest(consoleId, '/api/v1/operations/status')
    if (op.status !== 200 || op.body.running) throw createError({ statusCode: 409, message: 'PS5 выполняет другую операцию.' })
    const job: ConsoleSpeedJob = { id: randomUUID(), consoleId, ip:p.ip, state:'running', size:Number(sizeMiB)*1048576, startedAt:Date.now(), results:[] }
    const controller = new AbortController(); jobs.set(consoleId, {job,controller})
    void runConsoleSpeed(job, modes as SpeedMode[], controller.signal, { request: () => ps5OperationRequest(consoleId,'/api/v1/benchmark/info'), stream: (mode,bytes,signal) => ps5SpeedRequest(consoleId,mode,bytes,signal) }).then(() => {
      try { writeDurableJson(dataPath(`consoles/${consoleId}/speed-result.json`), job) } catch { job.error = `${job.error || ''} Результат не удалось сохранить на WEB.`.trim() }
    }).finally(release)
    return structuredClone(job)
  } catch (e) { release(); throw e }
}
export function cancelConsoleSpeed(consoleId: string, id: string) { const job=consoleSpeedJob(consoleId,id),value=jobs.get(consoleId);if(value?.job.id===id&&value.job.state==='running')value.controller.abort();return job }
export async function runConsoleSpeed(job: ConsoleSpeedJob, modes: SpeedMode[], signal: AbortSignal, io: { request: () => Promise<{status:number;body:any}>; stream: (mode:'upload'|'download'|'disk',size:number,signal:AbortSignal)=>Promise<Response> }) {
  try {
    for (const mode of modes) {
      signal.throwIfAborted();job.current=mode
      if (mode === 'latency') {
        const times:number[]=[]
        for(let n=0;n<9;n++){signal.throwIfAborted();const start=performance.now(),r=await io.request();if(r.status!==200||r.body.protocol!=='speed-test-v1')throw Error('ELF не подтвердил тест');if(n)times.push(performance.now()-start)}
        times.sort((a,b)=>a-b);job.results.push({mode,bytes:0,elapsedMs:times.reduce((a,b)=>a+b,0),latencyMinMs:times[0],latencyMedianMs:(times[3]!+times[4]!)/2,latencyMaxMs:times.at(-1) });continue
      }
      const start=performance.now(),r=await io.stream(mode,job.size,signal)
      if(r.status!==200){await r.body?.cancel();throw Error(`ELF отклонил тест (${r.status})`)}
      let writeMs:number|undefined,syncMs:number|undefined,cleanup:boolean|undefined,receivePipeline:boolean|undefined
      if(mode==='download') {
        if(r.headers.get('content-length')!==String(job.size)||r.headers.get('content-type')!=='application/octet-stream'){await r.body?.cancel();throw Error('Неверный размер ответа теста')}
        let bytes=0;const reader=r.body?.getReader();if(!reader)throw Error('Пустой ответ ELF')
        try{for(;;){signal.throwIfAborted();const p=await reader.read();if(p.done)break;bytes+=p.value.length;if(bytes>job.size)throw Error('Ответ превышает размер теста')}}finally{await reader.cancel().catch(()=>{})}
        if(bytes!==job.size)throw Error('Тест прерван: получен неполный объём')
      } else {
        const text=await r.text();if(text.length>4096)throw Error('Ответ теста слишком большой');const b=JSON.parse(text)
        if(b.protocol!=='speed-test-v1'||b.mode!==mode||b.bytes!==job.size||b.complete!==true||b.cleanup!==true||!Number.isFinite(b.elapsedMs)||b.elapsedMs<=0)throw Error('ELF не подтвердил полный тест или уборку временного файла')
        writeMs=b.writeMs;syncMs=b.syncMs;cleanup=b.cleanup;receivePipeline=b.receivePipeline===true
      }
      const elapsedMs=performance.now()-start;job.results.push({mode,bytes:job.size,elapsedMs,bytesPerSecond:job.size*1000/elapsedMs,writeMs,syncMs,cleanup,receivePipeline})
    }
    job.state='completed'
  }catch(e){job.state=signal.aborted?'cancelled':'failed';job.error=signal.aborted?'Тест остановлен':e instanceof Error?e.message:'Не удалось выполнить тест'}
  finally {job.finishedAt=Date.now();delete job.current}
}
