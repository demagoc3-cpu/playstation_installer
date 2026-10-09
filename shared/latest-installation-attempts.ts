/** History stays intact. The normal view shows the latest attempt per file/device. */
export function latestInstallationAttempts<T extends { psIp: string; platform?: string; packageId: string; createdAt: number }>(tasks: T[], includeHistory: unknown = false): T[] {
  if (includeHistory === true || includeHistory === 'true') return tasks
  const latest = new Map<string, T>()
  for (const task of tasks) {
    const key = `${task.psIp}:${task.platform || 'ps4'}:${task.packageId}`
    const previous = latest.get(key)
    if (!previous || task.createdAt > previous.createdAt) latest.set(key, task)
  }
  return [...latest.values()]
}
