export interface Ps5ServiceUpdateFlow {
  id: string; consoleId: string; ip: string; version: string; buildId: string; sha256: string
  state: 'preparing' | 'stopping' | 'sending' | 'verifying' | 'completed' | 'failed' | 'unconfirmed'
  message: string; previousPid?: number; startedAt: number
}
export interface UpdateConnection { send(data: Uint8Array): Promise<void>; close(): void }
export interface Ps5ServiceUpdateDriver {
  request(path: string, headers?: Record<string, string>): Promise<{ status: number; body: any }>
  health(): Promise<{ status: number; body: any }>
  connect(): Promise<UpdateConnection>
  idle(): boolean
  save(flow: Ps5ServiceUpdateFlow): void
  pause(): Promise<void>
}
export function ps5ServiceUpdateHealth(reply: { status: number; body: any }) {
  const health = reply.body
  return reply.status === 200 && health?.apiVersion === 'v1' && health.serviceReport?.service === 'PackageFlowService-PS5'
    && health.serviceReport?.platform === 'ps5' && health.serviceReport?.consoleVerified === true && Number.isInteger(health.pid) && health.pid > 0
    && versionParts(health.serviceReport.version) !== null && typeof health.serviceReport.buildId === 'string'
}
function versionParts(value: unknown): number[] | null {
  return typeof value === 'string' && /^\d+\.\d+\.\d+(?:-dev)?$/.test(value) ? value.split('-')[0]!.split('.').map(Number) : null
}
export function ps5ServiceUpdateAvailable(target: { version: string; buildId: string }, reply: { status: number; body: any }) {
  if (!ps5ServiceUpdateHealth(reply)) return false
  const current = versionParts(reply.body.serviceReport.version), candidate = versionParts(target.version)
  if (!current || !candidate) return false
  const difference = candidate.map((value, index) => value - current[index]!).find(value => value !== 0)
  return difference === undefined
    ? typeof reply.body.serviceReport.buildId === 'string' && !!reply.body.serviceReport.buildId && reply.body.serviceReport.buildId !== target.buildId
    : difference > 0
}
export function ps5ServiceUpdateReceipt(flow: Ps5ServiceUpdateFlow, reply: { status: number; body: any }) {
  return Number.isInteger(flow.previousPid) && ps5ServiceUpdateHealth(reply) && reply.body.pid !== flow.previousPid
    && reply.body.serviceReport.version === flow.version && reply.body.serviceReport.buildId === flow.buildId
}
async function activity(driver: Ps5ServiceUpdateDriver) {
  const reply = await driver.request('/api/v1/console/activity'), value = reply.body
  if (reply.status !== 200 || value?.complete !== true || typeof value.running !== 'boolean'
    || !Number.isSafeInteger(value.appId) || value.appId < 0 || value.appId > 2147483647 || typeof value.titleId !== 'string'
    || (value.running ? !/^(PPSA|CUSA)\d{5}$/.test(value.titleId) || value.appId === 0 : value.appId !== 0 || value.titleId !== '')) {
    throw new Error('PS5 не подтвердила запущенное приложение. Обновление не отправлено.')
  }
  return value as { running: boolean; appId: number; titleId: string }
}
/** Explicit update intent only. Any lost shutdown/upload reply stops the flow; GETs never resend. */
export async function runPs5ServiceUpdate(flow: Ps5ServiceUpdateFlow, bytes: Uint8Array, driver: Ps5ServiceUpdateDriver) {
  let loader: UpdateConnection | undefined
  const save = (state: Ps5ServiceUpdateFlow['state'], message: string) => { flow.state = state; flow.message = message; driver.save(flow) }
  try {
    if (!driver.idle()) throw new Error('На устройстве выполняется установка. Дождитесь завершения.')
    const old = await driver.request('/api/v1/status')
    if (!ps5ServiceUpdateHealth(old)) throw new Error('Текущая служба PS5 не подтверждена')
    if (old.body.serviceReport.version === flow.version && old.body.serviceReport.buildId === flow.buildId) {
      save('completed', `Сервис ${flow.version} уже установлен`); return
    }
    const currentVersion = versionParts(old.body.serviceReport.version), targetVersion = versionParts(flow.version)
    if (!currentVersion || !targetVersion) throw new Error('Версия текущей службы PS5 не распознана')
    const difference = targetVersion.map((value, index) => value - currentVersion[index]!).find(value => value !== 0)
    if (difference !== undefined && difference < 0) throw new Error('Выбранная версия PS5 старее установленной')
    flow.previousPid = old.body.pid
    const operations = await driver.request('/api/v1/operations/status')
    if (operations.status !== 200 || operations.body?.running !== false) throw new Error('Служба PS5 занята или не подтвердила состояние')
    const active = await activity(driver)
    if (active.running && active.titleId !== 'PPSA95001') throw new Error('Закройте игру на PS5 перед обновлением фоновой службы.')
    const pending = await driver.request('/api/v1/update/status')
    if (pending.status === 404) throw new Error('Текущая служба PS5 ещё не поддерживает обновление через WEB. Нужен первый запуск новой службы.')
    if (pending.status !== 200 || pending.body?.service !== 'PackageFlowService-PS5' || pending.body?.requested !== false) throw new Error('PS5 не подтвердила отсутствие другого обновления. Подождите и проверьте снова.')
    if (active.running) {
      const headers = { 'X-PackageFlow-Update-Id': flow.id }
      const prepare = await driver.request('/api/v1/update/prepare', headers)
      if (prepare.status === 404) throw new Error('Текущая служба PS5 ещё не поддерживает обновление через WEB. Нужен первый запуск новой службы.')
      if (prepare.status !== 200 || prepare.body?.requestId !== flow.id || prepare.body?.requested !== true) throw new Error('PS5 не приняла подготовку обновления')
      save('preparing', 'Закрываем интерфейс PackageFlow и проверяем готовность службы')
      let ready = prepare.body.ready === true
      for (let n = 0; !ready && n < 12; n++) {
        await driver.pause()
        const status = await driver.request('/api/v1/update/status')
        if (status.status !== 200 || status.body?.requestId !== flow.id || status.body?.requested !== true) throw new Error('Подготовка обновления прервана')
        ready = status.body.ready === true
      }
      if (!ready) throw new Error('Интерфейс ещё не подтвердил закрытие. Обновление не отправлено.')
    } else {
      // A closed UI cannot acknowledge /update/prepare. An authenticated complete
      // activity result plus no pending update permits the service's idle shutdown.
      save('preparing', 'Приложение закрыто; проверяем готовность фоновой службы')
    }
    if (!driver.idle() || (await activity(driver)).running) throw new Error('Интерфейс ещё не закрыт или устройство занято. Обновление не отправлено.')
    // Open the known loader before stopping the service; failed connection leaves it running.
    loader = await driver.connect()
    save('stopping', 'Останавливаем только фоновую службу PackageFlow')
    const stopped = await driver.request('/api/v1/shutdown')
    if (stopped.status !== 200 || stopped.body?.ok !== true || stopped.body?.scope !== 'packageflow-process') throw new Error('Остановка собственной службы не подтверждена')
    let gone = false
    for (let n = 0; n < 6; n++) {
      await driver.pause()
      let health
      try { health = await driver.health() }
      catch (error: any) {
        // A timeout or broken response is not proof that the old listener died.
        if ((error?.cause?.code || error?.code) === 'ECONNREFUSED') { gone = true; break }
        continue
      }
      if (!ps5ServiceUpdateHealth(health)) throw new Error('На порту службы отвечает неизвестный процесс. Новый ELF не отправлен.')
      if (health.body.pid !== flow.previousPid) throw new Error('На PS5 уже запущена другая служба')
    }
    if (!gone) throw new Error('Прежняя служба ещё работает. Новый ELF не отправлен.')
    save('sending', 'Передаём проверенную новую версию службы PS5')
    await loader.send(bytes); loader.close(); loader = undefined
    save('verifying', 'Проверяем новую версию службы и сохранённое сопряжение')
    for (let n = 0; n < 12; n++) {
      await driver.pause()
      try {
        const current = await driver.request('/api/v1/status')
        if (ps5ServiceUpdateReceipt(flow, current)) {
          save('completed', `Обновление подтверждено: сервис ${flow.version}`); return
        }
      } catch { /* Read-only receipt polls; neither payload nor shutdown is repeated. */ }
    }
    save('unconfirmed', 'Новая служба пока не подтвердила версию и сопряжение. Повтор не отправлен.')
  } catch (error) {
    const uncertain = ['stopping', 'sending', 'verifying'].includes(flow.state)
    save(uncertain ? 'unconfirmed' : 'failed', error instanceof Error ? error.message : 'Обновление не подтверждено')
  } finally { loader?.close() }
}
