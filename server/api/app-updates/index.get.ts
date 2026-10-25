import { appUpdateState } from '../../utils/app-updates';
export default defineEventHandler((event) => {
  setHeader(event, 'Cache-Control', 'no-store');
  return appUpdateState();
});
