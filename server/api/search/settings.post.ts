import { saveSearchSettings } from '../../utils/search-providers'
export default defineEventHandler(async (event) => saveSearchSettings(await readBody(event)))
