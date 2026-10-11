import { createError } from 'h3'
import type { InstallationTask } from '../../shared/types/tasks'

export function nativeTaskControls(platform: 'ps4' | 'ps5') {
  return { version: 1, actions: ['remove-items', 'remove-games', ...(platform === 'ps4' ? ['stop-reinstall'] : [])] }
}

/** New removal commands always use package IDs, never PS5 transfer IDs. */
export function normalizeNativeTaskControl(body: any, platform: 'ps4' | 'ps5') {
  if (!['remove-items', 'remove-games', 'stop-reinstall'].includes(body.action)) return undefined
  const id = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value)
  if (body.action === 'stop-reinstall') {
    if (platform !== 'ps4' || !id(body.maintenanceId) || body.queueId !== undefined || body.packageIds !== undefined || body.gameIds !== undefined)
      throw createError({ statusCode: 400, message: 'Укажите ID выбранной переустановки PS4' })
    return { maintenanceId: body.maintenanceId as string }
  }
  const key = body.action === 'remove-items' ? 'packageIds' : 'gameIds'
  const other = key === 'packageIds' ? 'gameIds' : 'packageIds', values = body[key]
  const pattern = key === 'packageIds' ? /^[a-zA-Z0-9_.-]{1,128}$/ : platform === 'ps4' ? /^ps4:[a-zA-Z0-9_.-]{1,123}$/ : /^ps[45]:[a-zA-Z0-9_.-]{1,123}$/
  if (!id(body.queueId) || body[other] !== undefined || body.maintenanceId !== undefined || !Array.isArray(values) || !values.length || values.length > 256 || values.some(value => typeof value !== 'string' || !pattern.test(value)))
    throw createError({ statusCode: 400, message: 'Укажите точную очередь и выбранные задания (не более 256)' })
  return { queueId: body.queueId as string, [key]: [...new Set(values as string[])].sort() }
}

export function nativeTaskRow(task: InstallationTask, platform: 'ps4' | 'ps5') {
  const bytes = task.progressPhase === 'source-check' ? task.bytesChecked || 0 : task.bytesSent
  return { ...task, id: platform === 'ps4' ? task.packageId : task.id,
    branchId: platform === 'ps4' ? `ps4:${task.titleId || task.packageId}` : (task as InstallationTask & { branch?: string }).branch,
    kind: ({ 'Игра': 'game', 'Патч': 'patch', 'Бэкпорт': 'backport', DLC: 'dlc' } as Record<string, string>)[task.type] || 'game',
    progress: task.state === 'installed' ? 100 : task.size ? Math.max(0, Math.min(99, Math.floor(bytes / task.size * 100))) : 0 }
}

export function normalizeNativeInstallReview(body: any) {
  if (typeof body.consoleId !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(body.consoleId) || !/^[a-f0-9]{64}$/.test(body.reviewToken || ''))
    throw createError({ statusCode: 400, message: 'Обновите и подтвердите проверку установки' })
  const list = (value: unknown, required = false) => {
    if (!Array.isArray(value) || required && !value.length || value.length > 10000 || value.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.-]{1,128}$/.test(id)))
      throw createError({ statusCode: 400, message: 'Некорректный подтверждённый набор пакетов' })
    return [...new Set(value as string[])].sort()
  }
  const packageIds = list(body.packageIds, true), overwritePackageIds = list(body.overwritePackageIds ?? [])
  if (overwritePackageIds.some(id => !packageIds.includes(id))) throw createError({ statusCode: 400, message: 'Переустановка содержит пакет вне выбранного набора' })
  return { consoleId: body.consoleId as string, reviewToken: body.reviewToken as string, packageIds, overwritePackageIds }
}
