import { Ps5QueueUncertain, type Ps5Item } from './ps5-queue-core'
import type { FolderRequest } from './ps5-folder-driver'

/** Only publication receipts from the handoff-aware root opt into this check.
 * A running app defers SMP scanning, including PackageFlow itself. Keep the
 * first publication time, but start the timeout after the console becomes idle.
 * No writes, registration commands or file reuploads are sent while waiting. */
export async function ps5RegistrationWait(item: Ps5Item, kind: 'folder' | 'image', receipt: any,
  signal: AbortSignal, request: FolderRequest, save: (patch: Partial<Ps5Item>) => void): Promise<Partial<Ps5Item>> {
  signal.throwIfAborted()
  const now = Date.now(), published = kind === 'folder' ? item.folderPublishedAt : item.imagePublishedAt
  if (!published) save(kind === 'folder' ? { folderPublishedAt: now } : { imagePublishedAt: now })
  if (typeof receipt.registrationRequest === 'string') {
    let activity: any
    try { const r = await request(item.transferId!, '/api/v1/console/activity', {}, undefined, signal); if (r.status === 200) activity = r.body }
    catch { signal.throwIfAborted() }
    const valid = activity?.complete === true && typeof activity.running === 'boolean' && Number.isSafeInteger(activity.appId) &&
      (activity.running ? activity.appId > 0 && /^(PPSA|CUSA)\d{5}$/.test(activity.titleId) : activity.appId === 0 && activity.titleId === '')
    if (valid && activity.running) {
      save({ registrationIdleSince: undefined, registrationBlockedByApp: true })
      return { state: 'installing', progressPhase: 'device-check', detail: `Файлы переданы. Закройте ${activity.titleId === 'PPSA95001' ? 'PackageFlow на PS5' : `приложение ${activity.titleId} на PS5`}: ShadowMount продолжит регистрацию автоматически` }
    }
    if (valid && !activity.running && (item.registrationBlockedByApp || !item.registrationIdleSince)) {
      save({ registrationIdleSince: now, registrationBlockedByApp: false })
      return { state: 'installing', progressPhase: 'device-check', detail: 'Файлы переданы. ShadowMount выполняет регистрацию на PS5' }
    }
    // Unknown activity cannot grant unlimited waiting after an earlier busy read.
    const since = valid ? item.registrationIdleSince ?? published ?? now : published ?? now
    if (now - since > 120_000) throw new Ps5QueueUncertain('Файлы переданы, но системная регистрация PS5 ещё не подтверждена. Проверьте ShadowMount. Повторная передача не отправлена')
  } else if (published && now - published > 120_000) {
    throw new Ps5QueueUncertain(kind === 'folder' ? 'Folder передан, но PS5 не подтвердила регистрацию за 2 минуты. Проверьте ShadowMount. Проверка продолжается; повторная передача не отправлена' : 'Образ передан, но системная регистрация ещё не подтверждена. Повтор не отправлен')
  }
  return { state: 'installing', progressPhase: 'device-check', detail: 'Файлы переданы. Ожидаем подтверждение регистрации игры от PS5' }
}
