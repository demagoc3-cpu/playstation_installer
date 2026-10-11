export interface BootstrapFlow {
  id: string; consoleId: string; ip: string; version: string; buildId: string; sha256: string; firmware: string; startedAt: number;
  state: 'checking' | 'sending' | 'verifying' | 'completed' | 'failed' | 'unconfirmed'; message: string
}
/** Closed PS5 ports may silently drop SYNs. Only an explicit first-start
 * confirmation permits that case; an accepted TCP connection is never absence. */
export async function bootstrapHealth(read: () => Promise<{ status: number; body: any }>, connects: () => Promise<boolean>, confirmedServiceStopped: boolean) {
  try { return await read() }
  catch (error: any) {
    if (error?.cause?.code === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') return null
    if (confirmedServiceStopped && error?.name === 'TimeoutError' && !await connects()) return null
    throw error
  }
}
export function bootstrapReceipt(flow: BootstrapFlow, r: { status: number; body: any }) {
  const h = r.body, s = h?.serviceReport
  return r.status === 200 && h?.apiVersion === 'v1' && s?.service === 'PackageFlowService-PS5' && s.platform === 'ps5' && s.consoleVerified === true
    && s.version === flow.version && s.buildId === flow.buildId && Number.isSafeInteger(h.pid) && h.pid > 0 && h.firmwareRead === true && /^0x1360[0-9a-f]{4}$/i.test(h.firmwareRaw || '')
}
export async function runPs5Bootstrap(flow: BootstrapFlow, bytes: Uint8Array, d: {
  idle(): boolean; health(): Promise<{ status: number; body: any } | null>;
  connect(): Promise<{ send(bytes: Uint8Array): Promise<void>; close(): void }>; save(flow: BootstrapFlow): void; pause(): Promise<void>
}) {
  let loader: Awaited<ReturnType<typeof d.connect>> | undefined
  const save = (state: BootstrapFlow['state'], message: string) => { flow.state = state; flow.message = message; d.save(flow) }
  try {
    if (!d.idle()) throw new Error('На приставке есть незавершённые задания. ELF не отправлен')
    const current = await d.health()
    if (current) {
      if (bootstrapReceipt(flow,current)) { save('completed','Эта версия ELF уже работает. Можно выполнить сопряжение'); return }
      throw new Error('На порту службы уже есть ответ. Сопрягите работающую службу и используйте обновление; второй ELF не отправлен')
    }
    loader = await d.connect()
    if (!d.idle() || await d.health()) throw new Error('Состояние приставки изменилось. ELF не отправлен')
    // Write-ahead receipt. Losing this response never permits an automatic resend.
    save('sending','Передаём полезную нагрузку PS5')
    await loader.send(bytes); loader.close(); loader = undefined
    save('verifying','Проверяем запущенную версию ELF')
    for (let i = 0; i < 15; i++) { await d.pause(); try { const r = await d.health(); if (r && bootstrapReceipt(flow,r)) { save('completed','ELF запущен. Продолжаем подключение к PS5'); return } } catch { /* Only reconcile; never resend. */ } }
    save('unconfirmed','ELF отправлен, запуск пока не подтверждён. Проверьте PS5; повтор не отправлен')
  } catch (e) { save(['sending','verifying'].includes(flow.state) ? 'unconfirmed' : 'failed', e instanceof Error ? e.message : 'Запуск ELF не подтверждён') }
  finally { loader?.close() }
}
