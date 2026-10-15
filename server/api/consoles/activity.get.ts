import { deviceActivities } from '../../utils/device-installation';
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  const ids = String(getQuery(event).packageIds || '')
    .split(',')
    .filter(Boolean);
  if (ids.length > 10000 || ids.some((id) => !/^[a-zA-Z0-9_.-]{1,128}$/.test(id)))
    throw createError({ statusCode: 400, message: 'Неверный список файлов' });
  return deviceActivities(ids);
});
