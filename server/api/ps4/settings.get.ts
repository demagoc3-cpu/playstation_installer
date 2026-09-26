import { getSavedPsIp } from '../../utils/ps4-installer'

export default defineEventHandler(() => ({ ip: getSavedPsIp() }))
