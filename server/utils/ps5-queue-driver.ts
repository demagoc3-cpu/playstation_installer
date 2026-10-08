import { open } from 'node:fs/promises'
import { blake3 } from '@noble/hashes/blake3.js'
import { getPackage } from './package-library'
import { ps5OperationRequest } from './console-profiles'
import { Ps5QueueFailure, Ps5QueueUncertain, type Ps5Driver, type Ps5Item } from './ps5-queue-core'
const pause = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  signal.throwIfAborted()
  const abort = () => { clearTimeout(timer); reject(signal.reason) }
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, 1000)
  signal.addEventListener('abort', abort, { once: true })
})
const stamp = (s: { size: number; mtimeMs: number; ino: number }) => `${s.size}:${s.mtimeMs}:${s.ino}`
export function ps5QueueDriver(consoleId: string): Ps5Driver {
  const request = async (item: Ps5Item, path: Parameters<typeof ps5OperationRequest>[1], headers = {}, body?: Uint8Array, signal?: AbortSignal) => {
    const r = await ps5OperationRequest(consoleId, path, { 'X-PackageFlow-Transfer-Id': item.transferId, ...headers }, body, signal)
    if ([400,401,403,413,422].includes(r.status)) throw new Ps5QueueFailure(`Сервис PS5 отклонил операцию (${r.status})`)
    if (r.status >= 500) throw new Error('PS5 operation unavailable')
    return r
  }
  return {
    async cancel(item) {
      const r = await request(item, '/api/v1/transfers/cancel')
      if ([200,404].includes(r.status)) return
      // Verification may have finished while cancellation was travelling. The
      // service retains a verified file; we can drop the WEB task only if it was
      // never passed to the installer. Do not stop or delete a system job.
      if (r.status === 409) {
        const transfer = await request(item,'/api/v1/transfers/status'), install = await request(item,'/api/v1/install/status')
        if (transfer.status === 200 && transfer.body.id === item.transferId && transfer.body.verified === true && install.status === 404) return
      }
      throw new Error('Cancellation not confirmed')
    },
    async run(item, signal, save) {
      // An intent is durably recorded BEFORE dispatch. Recovery never submits it again.
      if (item.installDispatched) {
        const receipt = await request(item, '/api/v1/install/status', {}, undefined, signal)
        if (receipt.status !== 200) throw new Ps5QueueUncertain('Сохранённый результат установки недоступен. Повтор не отправлен')
        if (receipt.body.state === 'submitting') return { state: 'installing', detail: 'Ожидаем ответ системного установщика' }
        if (receipt.body.ok === false) throw new Ps5QueueFailure('Системный установщик отклонил пакет')
        if (!receipt.body.ok || !/^[0-9-]{1,63}$/.test(receipt.body.job || '')) throw new Ps5QueueUncertain('Результат отправки неизвестен. Нужна сверка с приставкой')
        save({ serviceJobId: receipt.body.job })
        const job = await request(item, '/api/v1/installer/job', { 'X-PackageFlow-Installer-Job': receipt.body.job }, undefined, signal)
        if (job.status !== 200 || !job.body.ok) throw new Ps5QueueUncertain('Системное задание недоступно. Повтор не отправлен')
        if (job.body.phase === 'failed') throw new Ps5QueueFailure(`Ошибка системной установки: 0x${Number(job.body.code || 0).toString(16).toUpperCase()}`)
        // bytes served / app.pkg existence are not exact content/version receipts.
        if (job.body.phase === 'done') throw new Ps5QueueUncertain('Пакет передан установщику. Подтверждение конкретной версии ещё не поддерживается')
        return { state: 'installing', detail: 'PS5 выполняет системное задание' }
      }
      let source: ReturnType<typeof getPackage>
      try { source = getPackage(item.packageId) } catch { throw new Ps5QueueFailure('Пакет больше не доступен в библиотеке') }
      if (source.size !== item.size || source.contentId !== item.contentId || source.appVersion !== item.appVersion) throw new Ps5QueueFailure('Пакет изменился в библиотеке. Просканируйте его повторно')
      if (item.format !== 'pkg') throw new Ps5QueueFailure('Backend этого формата ещё не проверен на PS5')
      const file = await open(source.path, 'r').catch(()=> { throw new Ps5QueueFailure('Не удалось открыть исходный пакет') })
      try {
        const initial = await file.stat(), identity = stamp(initial)
        if (!initial.isFile() || initial.size !== item.size || item.sourceStamp && item.sourceStamp !== identity) throw new Ps5QueueFailure('Исходный файл изменился; передача остановлена')
        const buffer = Buffer.alloc(262144)
        if (!item.hash) {
          save({ state: 'verifying', detail: 'Проверяем целостность исходного пакета' })
          const hash = blake3.create(); let position = 0
          while (position < initial.size) { signal.throwIfAborted(); const r = await file.read(buffer, 0, Math.min(buffer.length, initial.size-position), position); if (!r.bytesRead) throw new Ps5QueueFailure('Исходный пакет обрезан'); hash.update(buffer.subarray(0,r.bytesRead)); position += r.bytesRead }
          if (stamp(await file.stat()) !== identity) throw new Ps5QueueFailure('Исходный файл изменился во время проверки')
          save({ hash: Buffer.from(hash.digest()).toString('hex'), sourceStamp: identity })
        }
        let response = await request(item, '/api/v1/transfers/begin', { 'X-PackageFlow-Size': String(item.size), 'X-PackageFlow-Blake3': item.hash! }, undefined, signal)
        if (response.status === 409) response = await request(item, '/api/v1/transfers/status', {}, undefined, signal)
        const valid = (body: any) => body?.id === item.transferId && body.size === item.size && body.blake3 === item.hash && Number.isSafeInteger(body.bytesDurable) && body.bytesDurable >= 0 && body.bytesDurable <= item.size && body.cancelled === false
        if (response.status !== 200 || !valid(response.body)) throw new Ps5QueueFailure('PS5 не подтвердила состояние передачи')
        let offset = response.body.bytesDurable
        save({ state: 'sending', bytesSent: offset, detail: 'Передаём пакет на PS5 с докачкой' })
        while (offset < item.size) {
          signal.throwIfAborted()
          const r = await file.read(buffer, 0, Math.min(buffer.length,item.size-offset), offset)
          if (!r.bytesRead || stamp(await file.stat()) !== identity) throw new Ps5QueueFailure('Исходный пакет изменился во время передачи')
          response = await request(item, '/api/v1/transfers/chunk', { 'X-PackageFlow-Offset': String(offset) }, buffer.subarray(0,r.bytesRead), signal)
          if (response.status !== 200 || !valid(response.body) || response.body.bytesDurable !== offset+r.bytesRead) throw new Error('Chunk acknowledgement lost; reconcile durable offset')
          offset = response.body.bytesDurable; save({ bytesSent: offset })
        }
        save({ state: 'verifying', detail: 'PS5 проверяет BLAKE3 полученного пакета' })
        response = await request(item, '/api/v1/transfers/commit', {}, undefined, signal)
        if (![200,202,409].includes(response.status)) throw new Ps5QueueFailure('Проверка пакета не началась')
        if (response.status === 409) return { state: 'waiting', detail: 'Служба завершает другую операцию; проверка будет продолжена' }
        for (;;) {
          signal.throwIfAborted()
          const transfer = await request(item, '/api/v1/transfers/status', {}, undefined, signal)
          if (transfer.status !== 200 || !valid(transfer.body)) throw new Ps5QueueFailure('Состояние пакета на PS5 изменилось')
          if (transfer.body.verified === true) break
          const operation = await request(item, '/api/v1/operations/status', {}, undefined, signal)
          if (operation.body.id === item.transferId && !operation.body.running && operation.body.status !== 200) throw new Ps5QueueFailure('Проверка целостности на PS5 завершилась ошибкой')
          if (!operation.body.running && operation.body.id !== item.transferId) return { state: 'waiting', detail: 'Служба перезапустилась. Повторим только проверку целостности' }
          await pause(signal)
        }
        signal.throwIfAborted()
        if (item.cancelRequested) signal.throwIfAborted()
        save({ state: 'installing', installDispatched: true, detail: 'Передаём проверенный пакет системному установщику' })
        response = await request(item, '/api/v1/install/staged', {}, undefined, signal)
        if (![200,202].includes(response.status)) throw new Ps5QueueUncertain('Ответ установщика потерян. Проверяем сохранённый результат без повторной отправки')
        return { state: 'installing' }
      } finally { await file.close() }
    },
  }
}
