import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { createError } from 'h3';
import { getConsoleProfile, ps5OperationRequest, ps5SpeedRequest } from './console-profiles';
import { getPs5Queue } from './ps5-installation-queue';
import { assertNoPs5ServiceUpdate } from './ps5-service-updates';
import { assertNoPs5Bootstrap } from './ps5-bootstrap-journal';
import { acquireConsoleSpeedTest } from './console-speed-lock';
import type { ConsoleSpeedJob, SpeedMode } from '../../shared/types/console-speed';
import { authenticatedServiceRequest, ps4SpeedRequest } from './ps4-service-installer';
import { peekInstallationQueue } from './installation-queue';
import { assertNoInstallation, assertNoRemoval } from './console-operation-store';
import { assertNoMaintenance } from './maintenance-store';
const jobs = new Map<string, { job: ConsoleSpeedJob; controller: AbortController }>();
function lastResult(consoleId: string): ConsoleSpeedJob | undefined {
  const live = jobs.get(consoleId)?.job;
  if (live) return structuredClone(live);
  const path = dataPath(`consoles/${consoleId}/speed-result.json`);
  if (!existsSync(path)) return;
  try {
    const job = JSON.parse(readFileSync(path, 'utf8'));
    if (
      job.consoleId === consoleId &&
      typeof job.id === 'string' &&
      ['completed', 'failed', 'cancelled'].includes(job.state) &&
      Array.isArray(job.results)
    )
      return job;
  } catch {}
}
export function consoleSpeedJob(consoleId: string, id: string) {
  getConsoleProfile(consoleId);
  const value = lastResult(consoleId);
  if (!value || value.id !== id) throw createError({ statusCode: 404, message: 'Тест не найден.' });
  return value;
}
export async function consoleSpeedInfo(consoleId: string) {
  const p = getConsoleProfile(consoleId);
  if (p.platform === 'ps4') {
    const q = peekInstallationQueue(p.ip),
      queue = { queueStatus: q.status, queueId: q.id, lastJob: lastResult(consoleId) };
    try {
      const body = (await authenticatedServiceRequest(p.ip, '/benchmark/info', 'GET')) as any;
      const supported =
        body?.service === 'PackegeFlowService' &&
        body.protocol === 'speed-test-v1' &&
        body.benchmarkApi === 1 &&
        body.maxBytes === 268435456 &&
        Array.isArray(body.modes) &&
        ['latency', 'upload', 'download', 'disk'].every((mode) => body.modes.includes(mode));
      return {
        ...queue,
        ready: supported && body.ready === true && body.busy === false,
        message: !supported
          ? 'Для PS4 требуется обновление службы с поддержкой тестов скорости.'
          : body.busy
            ? 'PS4 выполняет другую операцию. Дождитесь её завершения.'
            : body.ready !== true
              ? 'Тесты скорости ещё не проверены для этой службы PS4.'
              : '',
      };
    } catch (error: any) {
      return {
        ...queue,
        ready: false,
        message: [404, 405, 410].includes(error?.statusCode)
          ? 'Для PS4 требуется обновление службы с поддержкой тестов скорости.'
          : 'Не удалось подключиться к службе PS4. Проверьте подключение и сопряжение.',
      };
    }
  }
  const q = getPs5Queue(consoleId),
    queue = {
      queueStatus: q.status,
      queueId: q.id,
      lastJob: lastResult(consoleId),
      lastTransferProfile: q.items
        .map((i) => i.transferProfile)
        .filter((p) => p && Number.isFinite(p.measuredAt))
        .sort((a, b) => b!.measuredAt - a!.measuredAt)[0],
    };
  try {
    const r = await ps5OperationRequest(consoleId, '/api/v1/benchmark/info');
    return {
      ...queue,
      ready: r.status === 200 && r.body.protocol === 'speed-test-v1' && r.body.ready === true,
      message:
        r.status === 409
          ? 'PS5 завершает другую операцию. Обновите проверку через несколько секунд.'
          : r.status === 200
            ? r.body.ready
              ? ''
              : 'Тесты ещё не проверены для этой нагрузки.'
            : 'Обновите ELF: он пока не поддерживает тесты скорости.',
    };
  } catch {
    return {
      ...queue,
      ready: false,
      message: 'Не удалось подключиться к ELF. Проверьте подключение приставки.',
    };
  }
}
export async function beginConsoleSpeed(consoleId: string, sizeMiB: unknown, modes: unknown) {
  const p = getConsoleProfile(consoleId);
  if (
    !['ps4', 'ps5'].includes(p.platform) ||
    ![64, 128, 256].includes(Number(sizeMiB)) ||
    !Array.isArray(modes) ||
    !modes.length ||
    modes.length > 4 ||
    new Set(modes).size !== modes.length ||
    modes.some((mode) => !['latency', 'upload', 'download', 'disk'].includes(mode))
  )
    throw createError({ statusCode: 400, message: 'Выберите поддерживаемые тесты и размер.' });
  if (p.platform === 'ps5') {
    const q = getPs5Queue(consoleId);
    if (
      q.status === 'running' ||
      q.items.some(
        (item) =>
          item.installDispatched &&
          !['installed', 'failed', 'cancelled', 'skipped'].includes(item.state),
      )
    )
      throw createError({
        statusCode: 409,
        message:
          'Сначала приостановите передачу или дождитесь установки. Одновременный тест исказит скорость.',
      });
    assertNoPs5ServiceUpdate(consoleId);
    assertNoPs5Bootstrap(consoleId);
  } else {
    assertNoInstallation(p.ip);
    assertNoRemoval(p.ip);
    assertNoMaintenance(p.ip);
  }
  const release = acquireConsoleSpeedTest(consoleId);
  try {
    const info = await consoleSpeedInfo(consoleId);
    if (!info.ready) throw createError({ statusCode: 409, message: info.message });
    if (p.platform === 'ps5') {
      const op = await ps5OperationRequest(consoleId, '/api/v1/operations/status');
      if (op.status !== 200 || op.body.running)
        throw createError({ statusCode: 409, message: 'PS5 выполняет другую операцию.' });
    }
    const job: ConsoleSpeedJob = {
      id: randomUUID(),
      consoleId,
      ip: p.ip,
      state: 'running',
      size: Number(sizeMiB) * 1048576,
      startedAt: Date.now(),
      results: [],
    };
    const controller = new AbortController();
    jobs.set(consoleId, { job, controller });
    const io =
      p.platform === 'ps5'
        ? {
            request: () => ps5OperationRequest(consoleId, '/api/v1/benchmark/info'),
            stream: (mode: 'upload' | 'download' | 'disk', bytes: number, signal: AbortSignal) =>
              ps5SpeedRequest(consoleId, mode, bytes, signal),
          }
        : {
            request: async () => ({
              status: 200,
              body: await authenticatedServiceRequest(p.ip, '/benchmark/info', 'GET'),
            }),
            stream: (mode: 'upload' | 'download' | 'disk', bytes: number, signal: AbortSignal) =>
              ps4SpeedRequest(p.ip, mode, bytes, signal),
          };
    void runConsoleSpeed(job, modes as SpeedMode[], controller.signal, io)
      .then(() => {
        try {
          writeDurableJson(dataPath(`consoles/${consoleId}/speed-result.json`), job);
        } catch {
          job.error = `${job.error || ''} Результат не удалось сохранить на WEB.`.trim();
        }
      })
      .finally(release);
    return structuredClone(job);
  } catch (e) {
    release();
    throw e;
  }
}
export function cancelConsoleSpeed(consoleId: string, id: string) {
  const job = consoleSpeedJob(consoleId, id),
    value = jobs.get(consoleId);
  if (value?.job.id === id && value.job.state === 'running') value.controller.abort();
  return job;
}
export async function runConsoleSpeed(
  job: ConsoleSpeedJob,
  modes: SpeedMode[],
  signal: AbortSignal,
  io: {
    request: () => Promise<{ status: number; body: any }>;
    stream: (
      mode: 'upload' | 'download' | 'disk',
      size: number,
      signal: AbortSignal,
    ) => Promise<Response>;
  },
) {
  try {
    for (const mode of modes) {
      signal.throwIfAborted();
      job.current = mode;
      if (mode === 'latency') {
        const times: number[] = [];
        for (let n = 0; n < 9; n++) {
          signal.throwIfAborted();
          const start = performance.now(),
            r = await io.request();
          if (r.status !== 200 || r.body.protocol !== 'speed-test-v1')
            throw Error('Служба не подтвердила тест');
          if (n) times.push(performance.now() - start);
        }
        times.sort((a, b) => a - b);
        job.results.push({
          mode,
          bytes: 0,
          elapsedMs: times.reduce((a, b) => a + b, 0),
          latencyMinMs: times[0],
          latencyMedianMs: (times[3]! + times[4]!) / 2,
          latencyMaxMs: times.at(-1),
        });
        continue;
      }
      const start = performance.now(),
        r = await io.stream(mode, job.size, signal);
      if (r.status !== 200) {
        await r.body?.cancel();
        throw Error(`Служба отклонила тест (${r.status})`);
      }
      let writeMs: number | undefined,
        syncMs: number | undefined,
        cleanup: boolean | undefined,
        receivePipeline: boolean | undefined;
      if (mode === 'download') {
        if (
          r.headers.get('content-length') !== String(job.size) ||
          r.headers.get('content-type') !== 'application/octet-stream'
        ) {
          await r.body?.cancel();
          throw Error('Неверный размер ответа теста');
        }
        let bytes = 0;
        const reader = r.body?.getReader();
        if (!reader) throw Error('Пустой ответ службы');
        try {
          for (;;) {
            signal.throwIfAborted();
            const p = await reader.read();
            if (p.done) break;
            bytes += p.value.length;
            if (bytes > job.size) throw Error('Ответ превышает размер теста');
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        if (bytes !== job.size) throw Error('Тест прерван: получен неполный объём');
      } else {
        const reader = r.body?.getReader();
        if (!reader) throw Error('Пустой ответ службы');
        let size = 0;
        const chunks: Uint8Array[] = [];
        try {
          for (;;) {
            signal.throwIfAborted();
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > 4096) throw Error('Ответ теста слишком большой');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
        const b = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (
          b.protocol !== 'speed-test-v1' ||
          b.mode !== mode ||
          b.bytes !== job.size ||
          b.complete !== true ||
          b.cleanup !== true ||
          !Number.isFinite(b.elapsedMs) ||
          b.elapsedMs <= 0
        )
          throw Error('Служба не подтвердила полный тест или уборку временного файла');
        writeMs = b.writeMs;
        syncMs = b.syncMs;
        cleanup = b.cleanup;
        receivePipeline = b.receivePipeline === true;
      }
      const elapsedMs = performance.now() - start;
      job.results.push({
        mode,
        bytes: job.size,
        elapsedMs,
        bytesPerSecond: (job.size * 1000) / elapsedMs,
        writeMs,
        syncMs,
        cleanup,
        receivePipeline,
      });
    }
    job.state = 'completed';
  } catch (e) {
    job.state = signal.aborted ? 'cancelled' : 'failed';
    job.error = signal.aborted
      ? 'Тест остановлен'
      : e instanceof Error
        ? e.message
        : 'Не удалось выполнить тест';
  } finally {
    job.finishedAt = Date.now();
    delete job.current;
  }
}
