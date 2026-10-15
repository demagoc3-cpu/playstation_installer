import { storageManager } from '../../utils/storage-sources';
import { assertInstallationOrigin } from '../../utils/installation-origin';
import { saveQbitSettings } from '../../utils/qbittorrent';

export default defineEventHandler(async (event) => {
  assertInstallationOrigin(event, true);
  const body = await readBody(event);
  // Older launchers may still send their existing downloads directory.
  // Adopt it into Storage instead of maintaining an independent source list.
  const source = storageManager
    .list()
    .sources.find((item) => item.localPath === body?.downloadPath);
  if (source && (!source.enabled || source.kind !== 'local'))
    throw createError({
      statusCode: 400,
      message: 'Для загрузок выберите включённую локальную папку в «Хранилище»',
    });
  const result = await saveQbitSettings(body);
  storageManager.adoptLocal(result.downloadPath);
  return result;
});
