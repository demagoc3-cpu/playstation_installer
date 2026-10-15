import { readDeviceBatch } from '../../utils/device-installation';
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  return readDeviceBatch(String(getQuery(event).requestId || ''));
});
