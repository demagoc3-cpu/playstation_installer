import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createError } from 'h3';
import { dataPath } from './data-path';
import { writeDurableJson } from './durable-json';
import { getConsoleProfile, ps5OperationRequest } from './console-profiles';
import { ps5AppRelease } from './ps5-app-launch';
const pending = new Set<string>(),
  path = (id: string) => dataPath('consoles', id, 'ps5-app-stop.json');
function saved(id: string) {
  if (!existsSync(path(id))) return null;
  try {
    const v = JSON.parse(readFileSync(path(id), 'utf8'));
    if (
      !/^[0-9a-f]{32}$/.test(v.requestId) ||
      !/^PPSA95\d{3}$/.test(v.titleId) ||
      !['intent', 'accepted', 'closed', 'failed', 'unconfirmed'].includes(v.state)
    )
      throw Error();
    return v;
  } catch {
    throw createError({
      statusCode: 503,
      message: 'Не удалось прочитать результат закрытия. Повтор не отправлен',
    });
  }
}
export async function ps5AppStopInfo(id: string) {
  const p = getConsoleProfile(id);
  if (p.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Выберите PS5' });
  let flow = saved(p.id);
  if (flow && !['closed', 'failed'].includes(flow.state)) {
    try {
      const r = await ps5OperationRequest(p.id, '/api/v1/app/stop/status', {
        'X-PackageFlow-Request-Id': flow.requestId,
        'X-PackageFlow-UI-Title': flow.titleId,
      });
      if (
        r.status === 200 &&
        r.body.requestId === flow.requestId &&
        r.body.titleId === flow.titleId
      ) {
        flow = {
          ...flow,
          state:
            r.body.running === false
              ? 'closed'
              : r.body.state === 'failed'
                ? 'failed'
                : ['accepted', 'unconfirmed'].includes(r.body.state)
                  ? r.body.state
                  : 'unconfirmed',
          code: r.body.code,
        };
        writeDurableJson(path(p.id), flow);
      }
    } catch {
      /* A lost reply never causes another close command. */
    }
  }
  return {
    consoleId: p.id,
    flow,
    message: !flow
      ? ''
      : flow.state === 'closed'
        ? 'PackageFlow закрыт'
        : flow.state === 'failed'
          ? 'PS5 отклонила закрытие приложения'
          : 'Проверяем закрытие PackageFlow',
  };
}
export async function stopPs5App(id: string) {
  const p = getConsoleProfile(id);
  if (p.platform !== 'ps5') throw createError({ statusCode: 400, message: 'Выберите PS5' });
  if (pending.has(p.id)) return ps5AppStopInfo(p.id);
  pending.add(p.id);
  try {
    const info = await ps5AppStopInfo(p.id),
      release = ps5AppRelease();
    if (!release)
      throw createError({ statusCode: 409, message: 'Кандидат приложения не закреплён' });
    if (info.flow && !['closed', 'failed'].includes(info.flow.state)) return info;
    const status = await ps5OperationRequest(p.id, '/api/v1/app/status');
    if (status.status !== 200 || status.body.canStop !== true)
      throw createError({
        statusCode: 409,
        message: 'Обновите службу PS5 для закрытия приложения из WEB',
      });
    const flow = {
      ...release,
      requestId: randomBytes(16).toString('hex'),
      state: 'intent',
      startedAt: Date.now(),
    };
    writeDurableJson(path(p.id), flow);
    try {
      const r = await ps5OperationRequest(p.id, '/api/v1/app/stop', {
        'X-PackageFlow-Request-Id': flow.requestId,
        'X-PackageFlow-UI-Title': release.titleId,
        'X-PackageFlow-UI-Metadata-Hash': release.metadataHash,
      });
      if (
        r.status !== 200 ||
        r.body.requestId !== flow.requestId ||
        r.body.titleId !== flow.titleId ||
        !['accepted', 'failed', 'unconfirmed'].includes(r.body.state)
      )
        throw Error('PS5 не подтвердила закрытие; повтор не отправлен');
      writeDurableJson(path(p.id), { ...flow, state: r.body.state, code: r.body.code });
    } catch (e) {
      writeDurableJson(path(p.id), { ...flow, state: 'unconfirmed' });
      throw e;
    }
    return ps5AppStopInfo(p.id);
  } finally {
    pending.delete(p.id);
  }
}
