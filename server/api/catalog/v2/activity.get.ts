import { getConsoleProfile } from '../../../utils/console-profiles';
import { getTorrents, getQbitSettings } from '../../../utils/qbittorrent';
import { getPs5Queue, getPs5Tasks } from '../../../utils/ps5-installation-queue';
import { nativeTaskControls, nativeTaskRow } from '../../../utils/native-task-contract';
import { nativeInstallReviewCapability } from '../../../utils/native-install-review';
export default defineEventHandler(async (event) => {
  const q = getQuery(event),
    profile = getConsoleProfile(q.consoleId);
  if (profile.platform !== 'ps5')
    throw createError({ statusCode: 400, message: 'Выберите профиль PS5' });
  setHeader(event, 'Cache-Control', 'no-store');
  const base = {
    schemaVersion: 2,
    consoleId: profile.id,
    consolePlatform: 'ps5',
    queueId: '',
    queueStatus: 'idle',
    taskPage: 1,
    taskPages: 1,
    taskTotal: 0,
    counts: { active: 0, queued: 0, completed: 0, failed: 0 },
  };
  if (q.source !== 'web') {
    const queue = getPs5Queue(profile.id),
      mask = Number(q.mask),
      categories =
        Number.isInteger(mask) && mask >= 0 && mask <= 15
          ? ['active', 'queued', 'completed', 'failed'].filter((_, i) => mask & (1 << i)).join(',')
          : undefined;
    const page = getPs5Tasks(profile.id, { page: q.page, categories, view: 'table' });
    return {
      ...base,
      queueId: queue.id || '',
      queueStatus: queue.status,
      currentPackageId:
        queue.items.find((item) =>
          ['sending', 'verifying', 'installing', 'waiting', 'unconfirmed'].includes(item.state),
        )?.packageId || '',
      taskPage: page.page,
      taskPages: page.pages,
      taskTotal: page.total,
      counts: page.counts,
      taskControls: nativeTaskControls('ps5'),
      installReview: nativeInstallReviewCapability(),
      tasks: [
        ...new Map([...page.active, ...page.items].map((item) => [item.id, item])).values(),
      ].map((item) => nativeTaskRow(item, 'ps5')),
      message: queue.message,
    };
  }
  if (!getQbitSettings().configured)
    return {
      ...base,
      tasks: [],
      message: q.lang === 'en' ? 'Configure qBittorrent in WEB.' : 'Настройте qBittorrent в WEB.',
    };
  try {
    return {
      ...base,
      tasks: (await getTorrents()).slice(0, 256).map((t) => ({
        id: t.hash,
        title: t.name,
        kind: 'torrent',
        state: t.state,
        progress: Math.max(0, Math.min(100, Math.floor(t.progress * 100))),
        detail: `${(t.speed / 1048576).toFixed(1)} MB/s`,
        canCancel: false,
      })),
      message: '',
    };
  } catch {
    return {
      ...base,
      tasks: [],
      message:
        q.lang === 'en' ? 'WEB torrent client is unavailable.' : 'Торрент-клиент WEB недоступен.',
    };
  }
});
