import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createError } from 'h3'
import { serviceArtifact } from './service-updates'
import { ps4ServiceIp, readPs4Service } from './ps4-service'
import { getGoldHenStatus, savePsIp } from './ps4-installer'
import { registerPackageFile } from './package-library'
import { startInstallationQueue, getInstallationQueue } from './installation-queue'
import { assertDesktopWritable } from './desktop-lifecycle'

/** Initial installation uses the normal, durable PyLoader queue, without pairing. */
export async function bootstrapService(value: unknown, id: string, baseUrl: string) {
  assertDesktopWritable()
  const ip = ps4ServiceIp(value)
  if (!ip) throw createError({ statusCode: 400, message: 'Укажите IP PS4' })
  try {
    const reply = await readPs4Service(ip, '/ping')
    if (reply.status === 200 && (reply.body as any)?.service === 'PackegeFlowService')
      throw createError({ statusCode: 409, message: 'Сервис уже запущен на PS4. Откройте «Подключения» на приставке и выполните сопряжение.' })
  } catch (error: any) { if (error.statusCode === 409) throw error }
  if (!(await getGoldHenStatus(ip)).ready)
    throw createError({ statusCode: 502, message: 'На PS4 включите GoldHEN и PyLoader на порту 9090, затем повторите установку сервиса.' })
  const active = getInstallationQueue()
  if (active.status === 'running' || active.status === 'cancelling')
    throw createError({ statusCode: 409, message: 'Очередь уже работает. Дождитесь завершения текущей установки.' })
  const artifact = serviceArtifact(id)
  if (createHash('sha256').update(readFileSync(artifact.path)).digest('hex') !== artifact.sha256)
    throw createError({ statusCode: 409, message: 'PKG сервиса изменился после проверки.' })
  const pkg = await registerPackageFile(artifact.path)
  if (pkg.titleId !== 'PFLS00001' || pkg.contentType !== 'PS4GDE')
    throw createError({ statusCode: 400, message: 'Ожидается PKG PackageFlowService.' })
  const queue = startInstallationQueue({ psIp: ip, packageIds: [pkg.id], packageUrls: { [pkg.id]: `${baseUrl}/json/${pkg.id}.json` }, transport: 'payload' })
  savePsIp(ip)
  return { version: artifact.version, queue }
}
