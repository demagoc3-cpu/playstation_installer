import { setPs5ServiceAutoStart } from '../utils/console-profiles';
import { autoStartPs5Service } from '../utils/ps5-service-control';

/** A paired PS5 whose service stopped is started again from its PLDMGR record. */
export default defineNitroPlugin(() => {
  setPs5ServiceAutoStart(autoStartPs5Service);
});
