import { createHash } from 'node:crypto';
import { request, type ClientRequest, type IncomingMessage, type RequestOptions } from 'node:http';
import type { SetupElf } from './console-setup-artifacts';
import { ps4ServiceIp } from './ps4-service';
import { PS5_SERVICE_ELF_FILE_NAME } from './ps5-service-artifact';

export interface Ps5StoredPayload {
  path: string;
  slot: string;
  filename: string;
  name: string;
  version: string;
  buildId?: string;
}
type RequestFactory = (
  options: RequestOptions,
  response: (message: IncomingMessage) => void,
) => ClientRequest;
type Artifact = { manifest: SetupElf; bytes: Buffer };
const STORAGE_ROOT = '/data/pldmgr/payloads/';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const OWN_LOCAL_FOLDERS = new Set([
  'PackageFlowService-PS5',
  'packageflowservice-ps5',
  'packageflowservice',
]);

/** Structural identity only; version/SHA ownership still requires our receipt and live health. */
export function isPs5StoredServicePayload(payload: Ps5StoredPayload): boolean {
  if (!payload || typeof payload.path !== 'string' || typeof payload.slot !== 'string')
    return false;
  if (payload.filename !== PS5_SERVICE_ELF_FILE_NAME) return false;
  if (!payload.slot)
    return [...OWN_LOCAL_FOLDERS].some(
      (folder) => payload.path === `${STORAGE_ROOT}${folder}/${PS5_SERVICE_ELF_FILE_NAME}`,
    );
  const local = payload.slot.startsWith('local/') && OWN_LOCAL_FOLDERS.has(payload.slot.slice(6));
  const repository = /^repo\/packageflowservice(?:-ps5)?@[a-f0-9]{8}$/.test(payload.slot);
  return (
    (local || repository) &&
    payload.path === `${STORAGE_ROOT}${payload.slot}/${PS5_SERVICE_ELF_FILE_NAME}`
  );
}

/** A connected POST can have taken effect even when its reply was lost. */
export class PayloadManagerDispatchError extends Error {
  constructor(
    message: string,
    public readonly dispatched: boolean,
  ) {
    super(message);
    this.name = 'PayloadManagerDispatchError';
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function safePath(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1024 &&
    ![...value].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    !/[\\%?#]/.test(value) &&
    value
      .split('/')
      .every(
        (part, index) =>
          (index === 0 && part === '') || (part !== '' && part !== '.' && part !== '..'),
      )
  );
}
function field(value: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) {
    const result = value[key];
    if (typeof result === 'string' && result.length <= 256) return result;
  }
  return '';
}
function json(bytes: Buffer): unknown {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new PayloadManagerDispatchError('PLDMGR вернул неверный JSON', false);
  }
}

function managerRequest(
  ipValue: string,
  method: 'GET' | 'POST',
  path: string,
  body?: Buffer,
  makeRequest: RequestFactory = request,
): Promise<Buffer> {
  const ip = ps4ServiceIp(ipValue);
  if (!ip) return Promise.reject(new PayloadManagerDispatchError('Неверный IPv4 приставки', false));
  return new Promise((resolve, reject) => {
    let dispatched = false;
    let settled = false;
    let req: ClientRequest | undefined;
    const timer = setTimeout(() => req?.destroy(new Error('Таймаут PLDMGR')), body ? 60000 : 20000);
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new PayloadManagerDispatchError(error.message, dispatched));
    };
    try {
      req = makeRequest(
        {
          host: ip,
          port: 8084,
          path,
          method,
          agent: false,
          maxHeaderSize: 8192,
          headers: {
            'X-PLDMGR-Request': '1',
            Connection: 'close',
            ...(method === 'POST'
              ? { 'Content-Type': 'application/octet-stream', 'Content-Length': body?.length ?? 0 }
              : {}),
          },
        },
        (response) => {
          let size = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_RESPONSE_BYTES) {
              response.destroy(new Error('Ответ PLDMGR слишком большой'));
              return;
            }
            chunks.push(chunk);
          });
          response.on('error', fail);
          response.on('aborted', () => fail(new Error('PLDMGR прервал ответ')));
          response.on('end', () => {
            if (settled) return;
            if (response.statusCode !== 200) {
              fail(new Error(`PLDMGR отклонил запрос (HTTP ${response.statusCode ?? 0})`));
              return;
            }
            settled = true;
            clearTimeout(timer);
            resolve(Buffer.concat(chunks, size));
          });
        },
      );
      req.on('socket', (socket) => {
        const connected = () => {
          if (method === 'POST') dispatched = true;
          socket.setTimeout(20000, () => req?.destroy(new Error('PLDMGR не отвечает')));
        };
        if (socket.connecting) {
          const connectTimer = setTimeout(
            () => req?.destroy(new Error('PLDMGR недоступен на 8084')),
            3000,
          );
          socket.once('connect', () => {
            clearTimeout(connectTimer);
            connected();
          });
          socket.once('close', () => clearTimeout(connectTimer));
        } else connected();
      });
      req.on('error', fail);
      req.end(body);
    } catch (error) {
      req?.destroy();
      fail(error instanceof Error ? error : new Error('Ошибка запроса PLDMGR'));
    }
  });
}

function payloadList(value: unknown): Ps5StoredPayload[] {
  if (!object(value)) throw new PayloadManagerDispatchError('Неверный список PLDMGR', false);
  const modern = Array.isArray(value.items);
  const items: unknown[] = modern
    ? [...(value.items as unknown[]), ...(Array.isArray(value.usb) ? value.usb : [])]
    : Array.isArray(value.payloads)
      ? value.payloads
      : [];
  if ((!modern && !Array.isArray(value.payloads)) || items.length > 4096)
    throw new PayloadManagerDispatchError('Неверный список PLDMGR', false);
  const meta = object(value.meta) ? value.meta : {};
  const paths = new Set<string>();
  return items.map((entry) => {
    const path = modern && object(entry) ? entry.path : entry;
    if (!safePath(path) || !path.startsWith('/') || paths.has(path))
      throw new PayloadManagerDispatchError('Неоднозначный или неверный путь PLDMGR', false);
    paths.add(path);
    const filename = path.slice(path.lastIndexOf('/') + 1);
    const metadata = modern && object(entry) ? entry : object(meta[filename]) ? meta[filename] : {};
    const reportedFilename = field(metadata, 'filename');
    const slot = modern ? field(metadata, 'slot') : '';
    if (
      (reportedFilename && reportedFilename !== filename) ||
      (slot && (!safePath(slot) || slot.startsWith('/'))) ||
      (path.startsWith(STORAGE_ROOT) && modern && path !== `${STORAGE_ROOT}${slot}/${filename}`)
    )
      throw new PayloadManagerDispatchError('Метаданные PLDMGR не совпадают с путём', false);
    const buildId = field(metadata, 'buildId', 'build_id');
    return {
      path,
      slot,
      filename,
      name: field(metadata, 'display_name', 'name'),
      version: field(metadata, 'version'),
      ...(buildId ? { buildId } : {}),
    };
  });
}

export async function readPs5PayloadManager(ip: string, makeRequest: RequestFactory = request) {
  const versionBytes = await managerRequest(ip, 'GET', '/version', undefined, makeRequest);
  const version = versionBytes.toString('utf8').trim();
  if (version.length > 64 || !/^v?\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?$/.test(version))
    throw new PayloadManagerDispatchError('На порту 8084 не подтверждён PLDMGR', false);
  const payloads = payloadList(
    json(await managerRequest(ip, 'GET', '/list_payloads', undefined, makeRequest)),
  );
  return { version, payloads };
}

export async function launchPs5StoredPayload(
  ip: string,
  slotOrPath: string,
  makeRequest: RequestFactory = request,
  beforeDispatch?: (entry: Ps5StoredPayload) => void | Promise<void>,
): Promise<void> {
  if (!safePath(slotOrPath)) throw new PayloadManagerDispatchError('Неверная запись PLDMGR', false);
  const { payloads } = await readPs5PayloadManager(ip, makeRequest);
  const matching = payloads.filter(
    (payload) => payload.path === slotOrPath || payload.slot === slotOrPath,
  );
  if (
    matching.length !== 1 ||
    !isPs5StoredServicePayload(matching[0]!) ||
    payloads.filter((payload) => payload.filename === PS5_SERVICE_ELF_FILE_NAME).length !== 1
  )
    throw new PayloadManagerDispatchError(
      'Не найдена единственная сохранённая служба PackageFlow в PLDMGR',
      false,
    );
  const encoded = slotOrPath.split('/').map(encodeURIComponent).join('/');
  try {
    await beforeDispatch?.(matching[0]!);
  } catch (error) {
    throw new PayloadManagerDispatchError(
      error instanceof Error ? error.message : 'Проверка перед запуском не пройдена',
      false,
    );
  }
  const result = await managerRequest(
    ip,
    'POST',
    `/loadpayload:${encoded}`,
    undefined,
    makeRequest,
  );
  if (result.toString('utf8').trim() !== 'OK')
    throw new PayloadManagerDispatchError(
      'PLDMGR не подтвердил запуск; требуется сверка состояния',
      true,
    );
}

/** Explicit registration only: never overwrite, remove, or alter autoload entries. */
export async function storePs5ServicePayload(
  ip: string,
  artifact: Artifact,
  makeRequest: RequestFactory = request,
  beforeDispatch?: () => void | Promise<void>,
): Promise<Ps5StoredPayload> {
  if (
    artifact.manifest.fileName !== PS5_SERVICE_ELF_FILE_NAME ||
    artifact.bytes.length !== artifact.manifest.size ||
    artifact.bytes.length < 4096 ||
    artifact.bytes.length > 4 * 1024 ** 2 ||
    !artifact.bytes.subarray(0, 6).equals(Buffer.from('7f454c460201', 'hex')) ||
    artifact.bytes.readUInt16LE(18) !== 62 ||
    createHash('sha256').update(artifact.bytes).digest('hex') !== artifact.manifest.sha256
  )
    throw new PayloadManagerDispatchError(
      'Перед сохранением ELF службы PS5 не прошёл проверку',
      false,
    );
  const before = await readPs5PayloadManager(ip, makeRequest);
  if (before.payloads.some((payload) => payload.filename === PS5_SERVICE_ELF_FILE_NAME))
    throw new PayloadManagerDispatchError(
      'Служба уже сохранена в PLDMGR; автоматическая замена запрещена',
      false,
    );
  const check = json(
    await managerRequest(
      ip,
      'GET',
      `/manage:check?filename=${PS5_SERVICE_ELF_FILE_NAME}`,
      undefined,
      makeRequest,
    ),
  );
  // PLDMGR 0.6 strips the platform suffix before lower-casing the local key.
  if (
    !object(check) ||
    check.status !== 'ok' ||
    typeof check.folder_name !== 'string' ||
    !OWN_LOCAL_FOLDERS.has(check.folder_name) ||
    check.folder_exists !== false ||
    check.file_exists !== false ||
    (check.existing !== undefined && check.existing !== null) ||
    before.payloads.some(
      (payload) =>
        payload.path.startsWith(`${STORAGE_ROOT}${check.folder_name}/`) ||
        payload.path.startsWith(`${STORAGE_ROOT}local/${check.folder_name}/`),
    )
  )
    throw new PayloadManagerDispatchError(
      'Папка PLDMGR занята или её принадлежность не подтверждена',
      false,
    );
  try {
    await beforeDispatch?.();
  } catch (error) {
    throw new PayloadManagerDispatchError(
      error instanceof Error ? error.message : 'Проверка перед сохранением не пройдена',
      false,
    );
  }
  const result = await managerRequest(
    ip,
    'POST',
    `/manage:upload?filename=${PS5_SERVICE_ELF_FILE_NAME}&mode=new`,
    artifact.bytes,
    makeRequest,
  );
  if (result.toString('utf8').trim() !== 'OK')
    throw new PayloadManagerDispatchError(
      'PLDMGR не подтвердил сохранение; повтор не отправлен',
      true,
    );
  try {
    const after = await readPs5PayloadManager(ip, makeRequest);
    const matches = after.payloads.filter(
      (payload) => payload.filename === PS5_SERVICE_ELF_FILE_NAME,
    );
    const saved = matches[0];
    const expectedPaths = [
      `${STORAGE_ROOT}${check.folder_name}/${PS5_SERVICE_ELF_FILE_NAME}`,
      `${STORAGE_ROOT}local/${check.folder_name}/${PS5_SERVICE_ELF_FILE_NAME}`,
    ];
    if (!saved || matches.length !== 1 || !expectedPaths.includes(saved.path))
      throw new Error('PLDMGR не показал единственную сохранённую службу');
    if (
      JSON.stringify(after.payloads.filter((payload) => payload !== saved)) !==
      JSON.stringify(before.payloads)
    )
      throw new Error('Состав остальных записей PLDMGR изменился; требуется сверка');
    return saved;
  } catch (error) {
    throw new PayloadManagerDispatchError(
      error instanceof Error ? error.message : 'Сохранение требует сверки',
      true,
    );
  }
}
