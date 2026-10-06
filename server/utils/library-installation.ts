import { getLibraryPackages } from './package-library'
import { getInstallationQueue } from './installation-queue'
import { getLocalIp } from './ps4-installer'

export interface LibraryInstallationSelection { scope: 'all' | 'dlc'; titleId?: string }

/** Bulk actions resolve the full library here instead of downloading it to WEB. */
export async function libraryInstallationInput(selection: LibraryInstallationSelection, psIp: string, host: string) {
  if (!selection || !['all', 'dlc'].includes(selection.scope) ||
    (selection.titleId !== undefined && (typeof selection.titleId !== 'string' || !selection.titleId.trim()))) {
    throw createError({ statusCode: 400, message: 'Неверный выбор пакетов библиотеки' })
  }
  const queue = getInstallationQueue()
  const excluded = new Set(queue.psIp === psIp ? queue.items.filter(item => item.state !== 'cancelled').map(item => item.packageId) : [])
  const items = getLibraryPackages().filter(item => !item.installedAt &&
    ![item.id, ...(item.sourceIds || [])].some(id => excluded.has(id)) &&
    (selection.scope !== 'dlc' || item.type === 'DLC') && (!selection.titleId || item.titleId === selection.titleId))
    .sort((a, b) => a.installOrder - b.installOrder || a.title.localeCompare(b.title) || (a.appVersion || '').localeCompare(b.appVersion || '', undefined, { numeric: true }) || a.fileName.localeCompare(b.fileName, undefined, { numeric: true }))
  if (!items.length) throw createError({ statusCode: 400, message: 'Нет готовых выбранных пакетов' })
  const pcIp = await getLocalIp(psIp)
  const port = host.match(/:(\d+)$/)?.[1] || '3000'
  return { packageIds: items.map(item => item.id), packageUrls: Object.fromEntries(items.map(item => [item.id, `http://${pcIp}:${port}/json/${item.id}.json`])) }
}
