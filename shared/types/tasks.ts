export type TaskCategory = 'active' | 'queued' | 'completed' | 'failed'
export const TASK_CATEGORIES: TaskCategory[] = ['active', 'queued', 'completed', 'failed']
export function installationTaskCategory(state: string): TaskCategory {
  if (state === 'pending') return 'queued'
  if (['sending', 'waiting', 'receiving', 'installing', 'verifying'].includes(state)) return 'active'
  if (['failed', 'skipped', 'unconfirmed'].includes(state)) return 'failed'
  return 'completed'
}
export interface InstallationTask {
  id: string; queueId: string; packageId: string; psIp: string; title: string; fileName: string; type: string; size: number
  titleId: string; groupTitle: string; groupIconId?: string; contentId?: string; appVersion?: string; masterVersion?: string; requiredFirmware?: string; sdkFirmware?: string; contentType?: string; packageDigest?: string
  state: string; category: TaskCategory; detail: string; bytesSent: number; createdAt: number; completedAt?: number
  transport: string; canCancel: boolean; cancelRequested: boolean
}
export interface InstallationTasksPage {
  active: InstallationTask[]; items: InstallationTask[]; counts: Record<TaskCategory, number>; page: number; pages: number; total: number
  hiddenTorrents?: Record<string, string>
  unit: 'games' | 'tasks'
}
export const TASK_STATE_LABELS: Record<string, string> = { pending: 'В очереди', sending: 'Передача', waiting: 'Ожидаем загрузку PS4', receiving: 'Загрузка на PS4', installing: 'Установка', verifying: 'Проверка результата', delivered: 'Передано PS4', installed: 'Установлено', unconfirmed: 'Нет подтверждения', skipped: 'Пропущено', failed: 'Ошибка', cancelled: 'Отменено' }
export const installationTaskGroupKey = (task: InstallationTask) => `${task.psIp}:${task.titleId || task.packageId}`
