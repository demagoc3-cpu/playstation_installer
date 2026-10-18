import type {
  Ps5ServiceStartOperation,
  Ps5ServiceRelease,
} from '../../shared/types/ps5-service-start';
import { bootstrapReceipt } from './ps5-bootstrap-driver';
import { ps5ManifestFirmware } from './ps5-qualified-builds';

export interface Ps5ServiceLaunchRecord extends Ps5ServiceStartOperation {
  ip: string;
  sha256: string;
  firmware: string;
  action: 'start' | 'install';
  dispatched: boolean;
}
export interface Ps5ServiceStoredEntry {
  path: string;
  slot: string;
}
export interface Ps5ServiceLaunchDependencies {
  assertIdle(): void;
  assertTarget(): void;
  health(): Promise<{ status: number; body: any } | null>;
  manager(): Promise<{ available: boolean; entry?: Ps5ServiceStoredEntry; known: boolean }>;
  register(): Promise<Ps5ServiceStoredEntry>;
  launch(entry: Ps5ServiceStoredEntry): Promise<void>;
  connect(): Promise<{ send(): Promise<void>; close(): void }>;
  save(flow: Ps5ServiceLaunchRecord): void;
  pause(): Promise<void>;
}

export function ps5ServiceLaunchReceipt(
  release: Pick<Ps5ServiceRelease, 'version' | 'buildId' | 'firmware'>,
  response: { status: number; body: any },
) {
  return ps5ManifestFirmware(release.firmware) && bootstrapReceipt(release, response);
}

/** All mutations have a durable intent. A lost response never selects another transport. */
export async function runPs5ServiceLaunch(
  flow: Ps5ServiceLaunchRecord,
  dependencies: Ps5ServiceLaunchDependencies,
) {
  const d = dependencies;
  let connection: Awaited<ReturnType<typeof d.connect>> | undefined;
  let earlierMutation = flow.dispatched;
  const save = (state: Ps5ServiceLaunchRecord['state'], message: string) => {
    flow.state = state;
    flow.message = message;
    d.save(flow);
  };
  const beforeDispatch = () => {
    d.assertTarget();
    d.assertIdle();
  };
  try {
    beforeDispatch();
    const current = await d.health();
    if (current) {
      if (!ps5ServiceLaunchReceipt(flow, current))
        throw new Error('На PS5 уже отвечает другая версия службы. Используйте обновление службы');
      flow.method = 'running';
      save('completed', 'Нужная версия службы уже работает');
      return;
    }
    const manager = await d.manager();
    beforeDispatch();
    // A second fresh health read also protects against another client starting the service.
    if (await d.health()) throw new Error('Состояние службы изменилось. Обновите проверку');
    if (manager.entry && !manager.known && flow.action === 'start')
      throw new Error(
        'Версия сохранённой нагрузки не подтверждена. Установите проверенный комплект службы',
      );

    if (manager.available && (manager.known || (flow.action === 'install' && !manager.entry))) {
      flow.method = 'pldmgr';
      let entry = manager.entry;
      if (!manager.known) {
        // This is the explicit installation action, never a read or an implicit overwrite.
        save('starting', 'Сохраняем проверенную нагрузку на PS5');
        flow.dispatched = true;
        d.save(flow);
        entry = await d.register();
        earlierMutation = true;
      }
      if (!entry) throw new Error('Сохранённая нагрузка не найдена');
      beforeDispatch();
      const running = await d.health();
      beforeDispatch();
      if (running) {
        if (!ps5ServiceLaunchReceipt(flow, running))
          throw new Error(
            'На PS5 уже отвечает другая версия службы. Повторный запуск не отправлен',
          );
        flow.method = 'running';
        save('completed', 'Нужная версия службы уже работает');
        return;
      }
      save('starting', 'Запускаем сохранённую службу на PS5');
      flow.dispatched = true;
      d.save(flow);
      await d.launch(entry);
      earlierMutation = true;
    } else {
      flow.method = 'loader';
      save('starting', 'Подключаемся к загрузчику PS5');
      // No empty loader probes: a stock loader can execute/hang on an empty connection.
      connection = await d.connect();
      beforeDispatch();
      if (await d.health()) throw new Error('Состояние службы изменилось. ELF не отправлен');
      beforeDispatch();
      flow.dispatched = true;
      save('starting', 'Передаём проверенную нагрузку на PS5');
      await connection.send();
      earlierMutation = true;
      connection.close();
      connection = undefined;
    }
    save('verifying', 'Проверяем запущенную версию службы');
    for (let attempt = 0; attempt < 30; attempt++) {
      await d.pause();
      d.assertTarget();
      try {
        const response = await d.health();
        if (response && ps5ServiceLaunchReceipt(flow, response)) {
          save('completed', 'Служба PackageFlow запущена');
          return;
        }
      } catch {
        // Reconcile only. A timeout is not permission for a second send or launch.
      }
    }
    save('unconfirmed', 'Команда отправлена, запуск пока не подтверждён. Проверьте результат');
  } catch (error) {
    // A transport can prove that no mutation left the process (validation/connect refusal).
    if (
      error &&
      typeof error === 'object' &&
      'dispatched' in error &&
      error.dispatched === false &&
      flow.state === 'starting'
    )
      flow.dispatched = earlierMutation;
    save(
      flow.dispatched ? 'unconfirmed' : 'failed',
      error instanceof Error ? error.message : 'Не удалось подтвердить запуск службы',
    );
  } finally {
    connection?.close();
  }
}
