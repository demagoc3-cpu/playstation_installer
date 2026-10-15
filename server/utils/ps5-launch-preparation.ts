import { createHash } from 'node:crypto';

/** Prepare only the selected registered source. A lost mount acknowledgement
 * never allows a launch or a second mount request. */
export async function preparePs5GameLaunch(
  job: any,
  current: any,
  ports: {
    save(job: any): void;
    mount(id: string): Promise<any>;
    info(): Promise<any>;
    activity(): Promise<any>;
  },
) {
  if (
    current.mounted ||
    !current.managed ||
    !current.sourceAvailable ||
    !current.canManageSource ||
    !['image', 'folder'].includes(current.sourceType)
  )
    return job;
  const requestId = createHash('sha256')
    .update(`${job.id}:launch-mount`)
    .digest('hex')
    .slice(0, 32);
  job = { ...job, launchPreparation: { requestId, state: 'intent' } };
  ports.save(job);
  let receipt: any;
  try {
    receipt = await ports.mount(requestId);
  } catch {
    return {
      ...job,
      launchPreparation: { requestId, state: 'unconfirmed' },
      message: 'Подготовка образа не подтверждена; запуск не отправлен',
    };
  }
  if (
    receipt?.requestId !== requestId ||
    receipt.titleId !== job.titleId ||
    receipt.action !== 'mount' ||
    !['accepted', 'failed', 'unconfirmed'].includes(receipt.state)
  )
    return {
      ...job,
      launchPreparation: { requestId, state: 'unconfirmed' },
      message: 'Подготовка образа не подтверждена; запуск не отправлен',
    };
  job = { ...job, launchPreparation: { requestId, state: receipt.state, result: receipt.result } };
  ports.save(job);
  if (receipt.state !== 'accepted' || receipt.result?.status !== 0)
    return {
      ...job,
      state: receipt.state === 'failed' ? 'failed' : 'unconfirmed',
      result: { error: 'launch_mount_failed', stage: 'mount', ...receipt.result },
      message: 'PS5 не подготовила источник игры; запуск не отправлен',
    };
  try {
    const fresh = await ports.info(),
      active = await ports.activity();
    if (
      fresh.sourceIdentity !== job.sourceIdentity ||
      fresh.installed !== true ||
      fresh.mounted !== true ||
      active.complete !== true ||
      active.running
    )
      return {
        ...job,
        state: 'failed',
        result: { error: 'launch_source_changed', stage: 'mount' },
        message: 'Состояние PS5 изменилось после подготовки; запуск не отправлен',
      };
  } catch {
    return {
      ...job,
      state: 'failed',
      result: { error: 'launch_preparation_unavailable', stage: 'mount' },
      message: 'Не удалось проверить подготовку PS5; запуск не отправлен',
    };
  }
  return { ...job, nativeLaunchDispatched: true };
}
