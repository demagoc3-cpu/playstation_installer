import { startAppUpdateChecks } from '../utils/app-updates';
export default defineNitroPlugin(() => {
  startAppUpdateChecks();
});
