import type { InstallationTransport, ServiceInstallJob } from '../../shared/types/installation'

/** Omitted transport in a saved legacy queue means payload. New queues resolve the saved preference first. */
export function installationTransport(value: unknown): InstallationTransport {
  if (value === undefined || value === 'payload') return 'payload'
  if (value === 'service') return 'service'
  throw new Error('Неизвестный способ установки')
}

export function serviceJobDetail(job: ServiceInstallJob): string {
  if (job.state === 'installed') return 'Установка подтверждена PS4'
  if (job.state === 'failed') return job.errorHex.toUpperCase() === '0XFFFFD8D0'
    ? 'Загрузка завершена, но PS4 не подтвердила установку компонента. Проверьте его на приставке; очередь продолжена'
    : `Ошибка установки на PS4: ${job.errorHex}`
  if (job.state === 'cancelled') return 'Задание остановлено и снято с очереди PS4'
  if (job.state === 'cancelling') return `Ожидаем подтверждение отмены${job.error ? ` (${job.errorHex})` : ''}`
  if (job.state === 'uncertain') return `Состояние принятого задания требует проверки на PS4 (${job.errorHex}); повтор не отправлен`
  if (job.pollError) return `Задание принято; временно недоступен прогресс PS4 (код ${job.pollError})`
  if (job.state === 'installing') return 'Файл загружен; ожидаем подтверждение системной установки'
  const total = job.downloadTotalBytes || job.totalBytes
  const percent = total ? Math.min(100, Math.floor(job.downloadedBytes / total * 100)) : 0
  return job.downloadedBytes ? `PS4 скачивает пакет: ${percent}%` : 'Задание принято PS4; ожидаем скачивание'
}

export function validServiceJob(value: unknown): value is ServiceInstallJob {
  if (!value || typeof value !== 'object') return false
  const j = value as Record<string, unknown>
  return j.service === 'PackegeFlowService' && typeof j.jobId === 'string' && /^[0-9a-f-]{36}$/.test(j.jobId) &&
    j.requestId === j.jobId && typeof j.contentId === 'string' && typeof j.state === 'string' &&
    ['registering', 'downloading', 'installing', 'installed', 'failed', 'cancelling', 'cancelled', 'uncertain'].includes(j.state) &&
    ['totalBytes', 'downloadedBytes', 'downloadTotalBytes'].every(k => typeof j[k] === 'number' && Number.isSafeInteger(j[k]) && (j[k] as number) >= 0) &&
    ['taskId', 'error', 'pollError'].every(k => typeof j[k] === 'number' && Number.isInteger(j[k]) && (j[k] as number) >= -2147483648 && (j[k] as number) <= 2147483647) &&
    typeof j.errorHex === 'string' && /^0x[0-9a-f]{8}$/i.test(j.errorHex)
}
