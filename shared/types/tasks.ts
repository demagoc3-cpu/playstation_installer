import type { ContentPlatform, ContentFormat, PackageSignature } from './consoles';
export type TaskCategory = 'active' | 'queued' | 'completed' | 'failed';
export const TASK_CATEGORIES: TaskCategory[] = ['active', 'queued', 'completed', 'failed'];
export function installationTaskCategory(state: string): TaskCategory {
  if (state === 'pending') return 'queued';
  if (['sending', 'waiting', 'receiving', 'installing', 'verifying'].includes(state))
    return 'active';
  if (['failed', 'skipped', 'unconfirmed'].includes(state)) return 'failed';
  return 'completed';
}
export interface InstallationTask {
  consolePlatform?: 'ps4' | 'ps5';
  platform?: ContentPlatform;
  format?: ContentFormat;
  signature?: PackageSignature;
  id: string;
  queueId: string;
  packageId: string;
  psIp: string;
  title: string;
  fileName: string;
  type: string;
  size: number;
  titleId: string;
  groupTitle: string;
  groupIconId?: string;
  contentId?: string;
  appVersion?: string;
  masterVersion?: string;
  requiredFirmware?: string;
  sdkFirmware?: string;
  contentType?: string;
  packageDigest?: string;
  state: string;
  category: TaskCategory;
  detail: string;
  bytesSent: number;
  createdAt: number;
  completedAt?: number;
  transport: string;
  canConfirm?: boolean;
  canStopWaiting?: boolean;
  canDismiss?: boolean;
  canCancel: boolean;
  cancelRequested: boolean;
  progressPhase?: 'source-check' | 'transfer' | 'device-check';
  bytesChecked?: number;
  transferBytesPerSecond?: number;
  transferMeasuredAt?: number;
}
export interface InstallationTasksPage {
  active: InstallationTask[];
  items: InstallationTask[];
  counts: Record<TaskCategory, number>;
  page: number;
  pages: number;
  total: number;
  hiddenTorrents?: Record<string, string>;
  unit: 'games' | 'tasks';
  queueId?: string;
  queueStatus?: string;
  canCancelAll?: boolean;
  resumableQueues?: string[];
  maintenance?: { id: string; title: string; state: string; message: string; canStop: boolean };
}
export const TASK_STATE_LABELS: Record<string, string> = {
  pending: 'В очереди',
  sending: 'Передача',
  waiting: 'Ожидаем загрузку PS4',
  receiving: 'Загрузка на PS4',
  installing: 'Установка',
  verifying: 'Проверка результата',
  delivered: 'Передано PS4',
  installed: 'Установлено',
  unconfirmed: 'Нет подтверждения',
  skipped: 'Пропущено',
  failed: 'Ошибка',
  cancelled: 'Отменено',
};
export const installationTaskGroupKey = (task: InstallationTask) =>
  `${task.psIp}:${task.titleId || task.packageId}`;
export function installationTaskProgress(task: InstallationTask) {
  const bytes = task.progressPhase === 'source-check' ? task.bytesChecked || 0 : task.bytesSent;
  return task.size ? Math.max(0, Math.min(100, (bytes / task.size) * 100)) : 0;
}
export function installationTaskStateLabel(task: InstallationTask) {
  if (task.progressPhase === 'device-check' && task.state === 'verifying') return 'Проверка на PS5';
  if (task.progressPhase === 'source-check' && task.state === 'verifying')
    return 'Проверка исходного файла';
  if (task.platform === 'ps5' && task.state === 'waiting') return 'Ожидание PS5';
  if (task.platform === 'ps5' && task.state === 'receiving') return 'Загрузка на PS5';
  return TASK_STATE_LABELS[task.state] || task.state;
}

/** Hide stale responses. PS4 may report installing while still downloading. */
export function installationTaskSpeed(task: InstallationTask, now = Date.now()) {
  const ps4Download =
    (task.consolePlatform || task.platform) === 'ps4' &&
    (task.state === 'receiving' || task.state === 'installing') &&
    task.bytesSent < task.size &&
    task.progressPhase === 'transfer';
  const transmitting =
    ps4Download ||
    (task.state === 'sending' && task.progressPhase === 'transfer') ||
    (task.format === 'folder' &&
      task.state === 'verifying' &&
      task.progressPhase === 'device-check' &&
      task.bytesSent < task.size);
  if (
    !transmitting ||
    !Number.isFinite(task.transferBytesPerSecond) ||
    task.transferBytesPerSecond! < 0 ||
    !task.transferMeasuredAt
  )
    return undefined;
  return now - task.transferMeasuredAt > 5000 ? 0 : task.transferBytesPerSecond;
}

export function installationTaskRemainingMinutes(task: InstallationTask, now = Date.now()) {
  const rate = installationTaskSpeed(task, now);
  if (
    !rate ||
    !Number.isSafeInteger(task.size) ||
    !Number.isSafeInteger(task.bytesSent) ||
    task.bytesSent < 0 ||
    task.bytesSent >= task.size
  )
    return undefined;
  return Math.ceil((task.size - task.bytesSent) / rate / 60);
}

/** Match the progress bar's phase; source checks must not look like sent bytes. */
export function installationTaskMegabytes(task: InstallationTask) {
  const size = Number.isSafeInteger(task.size) && task.size > 0 ? task.size : 0;
  const raw = task.progressPhase === 'source-check' ? task.bytesChecked || 0 : task.bytesSent;
  const bytes = Number.isSafeInteger(raw) ? Math.max(0, Math.min(size, raw)) : 0;
  const total = Math.ceil(size / 1048576);
  return { transferred: bytes === size ? total : Math.floor(bytes / 1048576), total };
}
