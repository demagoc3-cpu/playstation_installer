import { createError } from 'h3';

type Target = {
  consoleId: string;
  ip: string;
  sha256: string;
  titleId: string;
  contentId: string;
  version: string;
  replaceSameVersion?: boolean;
  repairMissingSource?: boolean;
};
type Ports = {
  readJournal: () => any;
  saveJournal: (journal: any) => void;
  info: () => Promise<any>;
  activity: () => Promise<any>;
  hasCommand: (id: string) => boolean;
  command: (body: any) => Promise<any>;
  status: (id: string) => Promise<any>;
  presence: () => Promise<any>;
  newId: () => string;
  pause?: () => Promise<void>;
  storage?: (id: string) => Promise<any>;
};
const reject = (message: string) => createError({ statusCode: 409, message });
const idRx = /^[a-f0-9]{32}$/,
  identityRx = /^[a-f0-9]{64}$/,
  versionRx = /^\d{2}\.\d{3}\.\d{3}$/;
const ownContentId = 'IV0000-PPSA95001_00-PACKAGEFLOWUI001';

/** Only a modern, bound first-delete intent can carry local preflight proof.
 * Missing legacy records and accepted/unknown native commands remain unresolved. */
export function desktopAppDeleteWasNotDispatched(journal: any): boolean {
  const proof = journal?.deleteNotDispatched;
  return (
    journal?.sourceMissing === false &&
    journal.stopId === undefined &&
    journal.uninstallId === undefined &&
    typeof journal.consoleId === 'string' &&
    journal.consoleId.length > 0 &&
    typeof journal.ip === 'string' &&
    journal.titleId === 'PPSA95001' &&
    idRx.test(journal.deleteId) &&
    identityRx.test(journal.sourceIdentity) &&
    identityRx.test(journal.sha256) &&
    typeof journal.sourcePath === 'string' &&
    journal.sourcePath.startsWith('/') &&
    journal.sourcePath.length <= 1024 &&
    Number.isSafeInteger(journal.startedAt) &&
    journal.startedAt > 0 &&
    proof?.protocol === 'packageflow-delete-preflight-v1' &&
    proof.commandNotDispatched === true &&
    proof.consoleId === journal.consoleId &&
    proof.ip === journal.ip &&
    proof.sha256 === journal.sha256 &&
    proof.titleId === journal.titleId &&
    proof.contentId === ownContentId &&
    proof.sourceIdentity === journal.sourceIdentity &&
    proof.sourcePath === journal.sourcePath &&
    proof.requestId === journal.deleteId &&
    Number.isSafeInteger(proof.recordedAt) &&
    proof.recordedAt > 0
  );
}

/** An explicit update may replace only the owned, managed PackageFlow image.
 * Both stop and delete use durable identities; a lost acknowledgement is observed,
 * never repeated with a new command. No other running title may be stopped. */
export async function upgradeDesktopApp(target: Target, ports: Ports) {
  let journal = ports.readJournal();
  if (journal) {
    if (
      ['consoleId', 'ip', 'sha256', 'titleId'].some(
        (key) => journal[key] !== target[key as keyof Target],
      ) ||
      !idRx.test(journal.deleteId) ||
      !identityRx.test(journal.sourceIdentity) ||
      (journal.uninstallId !== undefined &&
        (!idRx.test(journal.uninstallId) || !identityRx.test(journal.uninstallIdentity))) ||
      (journal.stopId !== undefined &&
        (!idRx.test(journal.stopId) || !Number.isSafeInteger(journal.appId) || journal.appId <= 0))
    )
      throw reject('Журнал обновления не совпадает с комплектом или приставкой');
  } else {
    const current = await ports.info();
    if (
      target.titleId !== 'PPSA95001' ||
      current.titleId !== target.titleId ||
      current.contentId !== target.contentId ||
      !current.installed ||
      (current.sourceAvailable
        ? !current.managed || !current.canManageSource
        : target.repairMissingSource !== true) ||
      !identityRx.test(current.sourceIdentity) ||
      !identityRx.test(target.sha256) ||
      !versionRx.test(current.version) ||
      !versionRx.test(target.version) ||
      current.version > target.version ||
      (current.version === target.version && target.replaceSameVersion !== true)
    )
      throw reject(
        'Обновление разрешено только для прежней управляемой версии PackageFlow; понижение версии запрещено',
      );
    const activity = await ports.activity();
    if (activity.running && activity.titleId !== target.titleId)
      throw reject('Закройте игру перед обновлением PackageFlow');
    journal = {
      consoleId: target.consoleId,
      ip: target.ip,
      sha256: target.sha256,
      titleId: target.titleId,
      sourceIdentity: current.sourceIdentity,
      sourcePath: current.path,
      sourceMissing: !current.sourceAvailable,
      deleteId: ports.newId(),
      startedAt: Date.now(),
      ...(activity.running ? { stopId: ports.newId(), appId: activity.appId } : {}),
    };
    ports.saveJournal(journal);
  }
  const command = async (requestId: string, body: any) =>
    ports.hasCommand(requestId) ? ports.status(requestId) : ports.command({ requestId, ...body });
  if (journal.stopId) {
    const stopped = await command(journal.stopId, {
      titleId: journal.titleId,
      sourceIdentity: journal.sourceIdentity,
      action: 'stop',
      expectedAppId: journal.appId,
    });
    if (
      stopped.state !== 'accepted' ||
      !(stopped.result?.code === 0 || stopped.result?.status === 0)
    )
      throw reject('Закрытие PackageFlow пока не подтверждено. Повтор не отправлен');
  }
  if ((await ports.activity()).running)
    throw reject('На PS5 запущено приложение. Обновление пока не продолжено');
  if (!journal.sourceMissing) {
    // Clear old presend proof durably before attempting this ID again. An
    // interrupted later dispatch must never inherit a previous safe rejection.
    if (journal.deleteNotDispatched !== undefined) {
      delete journal.deleteNotDispatched;
      ports.saveJournal(journal);
    }
    let deleted: any;
    try {
      deleted = await command(journal.deleteId, {
        titleId: journal.titleId,
        sourceIdentity: journal.sourceIdentity,
        action: 'delete',
        confirmTitleId: journal.titleId,
      });
    } catch (error: any) {
      if (
        error?.data?.commandNotDispatched === true &&
        target.contentId === ownContentId &&
        !ports.hasCommand(journal.deleteId) &&
        journal.sourceMissing === false &&
        journal.stopId === undefined &&
        journal.uninstallId === undefined &&
        typeof journal.sourcePath === 'string' &&
        journal.sourcePath.startsWith('/') &&
        Number.isSafeInteger(journal.startedAt) &&
        journal.startedAt > 0
      ) {
        journal.deleteNotDispatched = {
          protocol: 'packageflow-delete-preflight-v1',
          commandNotDispatched: true,
          consoleId: journal.consoleId,
          ip: journal.ip,
          sha256: journal.sha256,
          titleId: journal.titleId,
          contentId: target.contentId,
          sourceIdentity: journal.sourceIdentity,
          sourcePath: journal.sourcePath,
          requestId: journal.deleteId,
          recordedAt: Date.now(),
        };
        ports.saveJournal(journal);
      }
      throw error;
    }
    if (deleted.state !== 'accepted' || deleted.result?.status !== 0)
      throw reject(
        'Удаление прежнего образа PackageFlow пока не подтверждено. Повтор не отправлен',
      );
    if (deleted.result.job_id && !journal.deleted) {
      let storage = deleted.storage || deleted.result;
      for (let poll = 0; poll < 45; poll++) {
        if (
          storage.job_id !== deleted.result.job_id ||
          (journal.sourcePath && storage.source !== journal.sourcePath)
        )
          throw reject('PS5 сообщает о другом задании удаления');
        if (storage.active === false) {
          if (storage.state !== 'completed' || storage.result_status !== 0)
            throw reject('PS5 не подтвердила удаление прежнего образа');
          break;
        }
        if (storage.active !== true || poll === 44)
          throw reject('Удаление образа ещё не подтверждено. Повтор не отправлен');
        await (ports.pause?.() || new Promise((resolve) => setTimeout(resolve, 500)));
        const observed = await (ports.storage?.(journal.deleteId) ||
          ports.status(journal.deleteId));
        storage = observed.storage || observed.result;
      }
    }
  }
  let presence = await ports.presence();
  if (presence.state !== 'absent') {
    // app.db can retain the registration after the managed image was deleted.
    // That registration must not turn the replacement into an "already installed" skip.
    const remaining = await ports.info();
    if (
      remaining.titleId !== target.titleId ||
      remaining.contentId !== target.contentId ||
      remaining.sourceAvailable !== false
    )
      throw reject('PS5 ещё не подтвердила удаление прежнего образа. Повтор не отправлен');
    if (!journal.uninstallId) {
      journal.uninstallId = ports.newId();
      journal.uninstallIdentity = remaining.sourceIdentity;
      ports.saveJournal(journal);
    }
    if (!idRx.test(journal.uninstallId) || !identityRx.test(journal.uninstallIdentity))
      throw reject('Не удалось проверить снятие регистрации PackageFlow');
    const removed = await command(journal.uninstallId, {
      titleId: journal.titleId,
      sourceIdentity: journal.uninstallIdentity,
      action: 'uninstall',
      confirmTitleId: journal.titleId,
    });
    if (removed.state !== 'accepted' || removed.result?.status !== 0)
      throw reject('PS5 ещё не подтвердила снятие прежней регистрации. Повтор не отправлен');
    for (let poll = 0; poll < 30; poll++) {
      presence = await ports.presence();
      if (presence.state === 'absent') break;
      if (poll === 29)
        throw reject('Прежняя регистрация ещё видна на PS5. Повторная команда не отправлена');
      await (ports.pause?.() || new Promise((resolve) => setTimeout(resolve, 500)));
    }
  }
  journal.deleted = true;
  ports.saveJournal(journal);
  return presence;
}
