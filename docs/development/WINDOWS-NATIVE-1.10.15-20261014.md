# PackageFlow Windows 1.10.15 — финальный кандидат установлен на GAMEPAD-PC

**Статус:** штатный update 1.10.14 → 1.10.15 и последующее обновление финальным кандидатом с selective readiness deadline завершились с NSIS exit 0 после прямого разрешения пользователя. Новые EXE/native hashes подтверждены. Windows Native/UI/background и packaged WEB проверки PASS; final first start и tray/IPC PASS. Рабочие процессы на момент передачи управления: PackageFlow **12832**, Node **8276**, Session 1; http://127.0.0.1:3000 отвечает PackageFlow/busy:false. Последующих stop/restart/prepare-update/full console probes этот чат не выполняет. Аппаратные прогоны Battlefield завершены координирующим чатом; итог и сохранённая оговорка приведены ниже.

## Измеренная поставка

- EXE: `dist/windows/PackageFlowSetup-1.10.15-x64.exe`.
- Размер: **105 756 999 байт** (100,858 MiB).
- 1.10.14: 322 613 541 байт. Уменьшение: **216 856 542 байт / 67,218673%**.
- SHA256 EXE: `ef0b42e5d6f6c24675dc3c36ee42aa03ce400b28907eaf6308186a08fd7a9c75`.
- SHA256 нового лаунчера в payload: `bb990e20ee6c6f90d6af84643426fe85b10eb141bea4f2a439bdf64363b348f2`.
- Windows и Core реально скомпилированы с версией 1.10.15.0, ссылки проверены BundleCheck. Предыдущий EXE не переименовывался.
- В payload нет полного offline Runtime, bootstrapper binary, compose-каталога, Dockerfile, docker-compose YAML или Docker Desktop installer. Основная экономия связана с исключением большого Runtime, не с небольшими контейнерными файлами.
- Node.js 22.23.3 и WEB встроены. .NET остаётся self-contained single-file win-x64. SDK WebView2 1.0.4191.47, Vue 3.5.42, Vite 7.3.1.
- PS4 2.14: `83995a02c90e8dc6fb775243f911573dc3e2b0acd390e0f3d2d591c1dc554abf`.
- PS5 ELF 026f: `2441b7ebe3aa6b265cb186512b5dd94f62666d40e16a71685d930c5b232a7732`.
- PS5 app 01.000.044 / 5122c1f: `18f64a693842d9136d7703377cd368a1a067fe760d87626b8ba949945e6806e6`.

Три PS-артефакта не менялись и не пересобирались. На PS5 ничего не передавалось. [Параметры/манифесты сборки](evidence/windows-native-20261014/build.json), [аудит payload](evidence/windows-native-20261014/payload-audit.txt).

## Runtime устанавливается по необходимости

Большой `MicrosoftEdgeWebView2RuntimeInstallerX64.exe` исключён из стандартного NSIS и инкрементального build payload. Маленький bootstrapper также не поставляется: отсутствующая зависимость загружается по закреплённому HTTPS URL Microsoft. На подходящем установленном Runtime (SDK version >=120.0.0.0 без preview suffix) этот путь обходится до создания HTTP-клиента, чтения pin или запуска installer.

Выбран официальный Evergreen bootstrapper: 1 860 304 байт, SHA256 `baa78c71c5615533a1ee0c4d2ca2ea3fd24dae01965f9033ac530a61b5aa93a0`. Он определяет архитектуру и скачивает актуальный Runtime Microsoft. Поставлять полный 214 090 448-байтный Standalone для редкого случая отсутствия зависимости не требуется. Официальный источник: [Microsoft WebView2 distribution](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution), [download page](https://developer.microsoft.com/en-us/microsoft-edge/webview2/). Закреплённый файл получен локально по HTTPS; его размер/хэш измерены. Настоящая Windows Authenticode-проверка файла выполнена: Valid/Microsoft signer; unsigned junk отклонён. Microsoft Setup не запускался.

Загрузка ограничена HTTPS Microsoft CDN, размером, закреплённым SHA256 и числом redirects. Посторонний host, порт, userinfo, HTTP, неполная/избыточная загрузка и неверный hash отклоняются. Затем Windows должна вернуть Authenticode `Valid` и Microsoft Corporation signer. Файл удерживается открытым без права изменения/удаления до запуска. Это не бесконтрольное выполнение ответа download/redirect.

До Vue отображается нативная панель: проверка Runtime, измеряемый процент скачивания bootstrapper, проверка подписи, установка Microsoft с неопределённым процентом и SDK verification. При отсутствии интернета, отказе Microsoft, плохом hash/signature, ненулевом exit или отсутствии Runtime после установки остаётся конкретная ошибка и ручной повтор/проверка/закрытие, а не пустое окно. Код 0 сам по себе не даёт ready.

Dispatch записывается до запуска. Таймаут/неопределённое завершение сохраняет journal и запрещает повторную отправку installer; Microsoft Setup не убивается. Пользователь может проверить SDK снова после его завершения или воспользоваться официальной ручной установкой. Известная ошибка допускает ручной повтор, не автоматический цикл на каждом старте.

Setup запускается без повышения прав. Microsoft поддерживает per-user установку в соответствующем контексте, но политики/права Windows могут её ограничить. Универсальная установка без admin не обещается. Runtime нужен также при отказе от торрентов; Chromium/FlareSolverr — отдельная зависимость. Vue/assets остаются локальными. Интернет требуется для подготовки отсутствующего Runtime и для явно используемых внешних функций/скачивания выбранных компонентов.

## Windows — только Native

Удалены переключатель режима, Docker link, compose-параметры, bridge action `docker` и поля `mode`/`composeProwlarr`. C# больше не генерирует контейнерные configs и не вызывает docker/docker compose при старте, установке, остановке или обновлении. Удалён Windows Compose generator и его специальные build fixtures. Windows release.json содержит только версию; Docker image env/options удалены из обоих build entrypoints и Windows workflow. Общие корневые `Dockerfile` и `docker-compose.yml` основного WEB не менялись.

Сохранены локальный стеклянный UI, пять страниц, мастер, Native library/LAN/ports/autostart, Prowlarr/qBittorrent/FlareSolverr, ручной RuTracker/CAPTCHA, ключи/индексаторы, профили и координатор PS4/PS5, обновления, поддержка/QR, IPC и трей. qBittorrent/Prowlarr/FlareSolverr/их Chromium не добавлены в поставку; докачка остаётся связанной с выбором поиска/торрентов. Локальный URL UI содержит версию, чтобы после обновления не использовать прежний HTML с удалёнными bridge-полями.

## Миграция прежних профилей

Native-профили сохраняют параметры и данные. Прежний `Mode=compose` (включая старые имена JSON-полей другого регистра) читается как Native с обязательным review, не как готовая пустая установка. До сохранения исходный launcher.json копируется целиком в `.pre-native-1.10.15.json`: неизвестные прежние поля и DPAPI blobs не теряются. Неизвестные или неоднозначные настройки не исправляются молча.

С pending review запрещены автоматический старт/adopt и изменяющие bridge-команды. Guard не посылает старому контейнерному launcher его прежнюю команду остановки: пользователь должен закрыть старый launcher, закончить jobs и вручную остановить старый WEB. Занятые WEB/callback порты запрещают подготовку обновления/импорт. Программа не останавливает и не удаляет Docker Desktop, контейнеры/volume и не выполняет prune.

Старый JSON-конфиг читается только для определения bind-каталога. При стандартном bind либо выбранном полном Windows-экспорте `/app/.data` создаётся **отдельная** копия. Исходные файлы не меняются. Ключи, пары, записи/IDs и параметры копируются; известные `/games` и `/app/.data` пути переводятся в Windows. Remote-path внешнего qBittorrent сохраняется. Известные контейнерные loopback aliases в URL переводятся в localhost. После импорта следует проверить сетевые хранилища в WEB.

Для внешнего volume требуется полный экспорт через Docker Desktop с ключами/скрытыми файлами; программа не заявляет, что сама прочитала или перенесла volume. Пустая подмена такого экспорта запрещена. Исключение — действительно пустой обнаруженный bind-каталог с отдельным явным подтверждением отсутствия данных. Непонятный/повреждённый JSON, отсутствующий vault key, непереносимые локальные пути, traversal/symlinks, изменяющийся экспорт и незавершённые installation queues блокируют импорт. Staging отбрасывается; source и volume остаются целыми.

NSIS удаляет только известные прежние файлы поставки внутри установленного приложения по точным sizes/SHA256: старый Standalone Runtime и два прежних контейнерных build files. Изменённый файл или reparse point сохраняется, обновление останавливается для ручной проверки. Общий Runtime Microsoft и пользовательские Downloads не затрагиваются.

## Проверки — выполнено локально

- Core suite PASS: installed resolver bypass, missing dependency orchestration с подменой resolver/process, ручной retry, timeout/zero-exit-but-still-missing, отсутствие replay, плохие hash/signature, network errors, проверенные transport bytes и отказ от опасных redirects.
- Core migration PASS: Native/legacy profiles и регистр JSON, точная backup с неизвестными полями, отдельный import, неизменный source, known path conversion, сохранение IDs/секретов/key, external volume/empty guard, traversal и pending queue refusal. DPAPI в cross-platform fixtures непрозрачен; отдельно реальные Windows migration/UI fixtures подтвердили сохранение и чтение секретов.
- WEB desktop-control/desktop-console-flow/desktop-app-upgrade: 3 suites PASS.
- Vue/Chrome: пять разделов и мастер на точных 1000×700, 1280×800, 1920×1080: без page errors, горизонтального переполнения и перекрытия основных действий. Отдельный migration-only UI: 1000×700/1280×800, без mode selector и без false launch hero.
- Windows harness выполнен на GAMEPAD-PC: background, Native, UI и packaged WEB — exit 0. Изолированные данные, без PS transfers.
- BundleCheck 1.10.15.0 PASS; 26 внешних Desktop-файлов точно соответствуют manifest; аудит исключает старую поставку и проверяет все PS hashes. Incremental build очищает старые owned artifacts. Итоговый NSIS собран с фиксированным payload отдельным завершающим проходом.
- Entrypoints Linux/Windows согласованы по Native-only, pin/cleanup/audit и Node 22.23.3. Linux build выполнен. Windows build.ps1 ещё не исполнен на Windows; воспроизводимость его реального запуска не заявляется.

[Core](evidence/windows-native-20261014/core-tests.txt), [WEB](evidence/windows-native-20261014/server-tests.txt), [layout](evidence/windows-native-20261014/layout-checks.json), [migration UI](evidence/windows-native-20261014/migration-ui-checks.json), [harness compile](evidence/windows-native-20261014/windows-harness-build.log). Все preview-снимки — [локальные фикстуры](../design/windows-native-20261014/local/), а не кадры установленного 1.10.15.

## Реальные Windows-проверки и обновление

- `--background-probes`: настоящий callback 15-секундного timer отправляет `background:true`; explicit refresh поле не отправляет. Транспорт подменён, реальных WEB/PS-запросов нет.
- `--windows-native`: SDK обнаружил установленный Runtime; download/install counters = 0. Настоящий bootstrapper Microsoft загружен по HTTPS, проверены закреплённые bytes/SHA256 и Authenticode Valid/Microsoft. Unsigned junk отклонён; Microsoft Setup не запускался.
- Реальная миграционная фикстура: старый Compose-профиль не запускает/не принимает внешний сервер, занятый loopback-порт блокирует prepare-update, import создаёт отдельную копию, DPAPI/пары/настройки сохраняются. Внешних API-вызовов нет.
- `--desktop-ui`: локальный WebView2, пять разделов, мастер, password reveal, диалоги default-safe/Escape/confirm, origin/command allowlist, отсутствие секретов в состоянии, DPAPI save/reload, сохранение пароля при пустом вводе и очистка при смене аккаунта — PASS. Запрошенные размеры 1000×700/1280×800/1920×1080 и WebView zoom 100/125/150%; реальный viewport при ограничении экраном записан в отчёт. Это zoom, OS DPI не менялся.
- `--web-runtime`: фактические Node/WEB из установленной поставки запущены с отдельными данными/портами; каталог PS4/PS5, launcher authorization, fresh WEB-only без установки torrent components, busy refusal и подтверждённая остановка — PASS. Рабочий пользовательский WEB не останавливался этим тестом.
- Обновление: SHA256 скачанного EXE совпал; desktop `busy:false`; затем обычный NSIS `/S` со штатным guard. Exit 0, installed EXE **1.10.15.0**, registry **1.10.15**, native SHA256 совпал с payload. 26 Desktop-файлов и все три PS-артефакта проверены.
- До первого запуска все сравниваемые настройки, DPAPI blobs и hashes `console-profiles.json`, `ps5-service-keys.json`, `storage-sources.json`, `package-library.json` совпали. После старта сохранённые tracker/launcher/Prowlarr секреты имеют прежние расшифрованные значения. Prowlarr ciphertext пересоздан DPAPI; это не смена ключа. До обновления уже были `TorrentSetupSelected:true` и `AutomaticSetupPending:true`; штатное возобновление создало ранее отсутствовавший managed qBittorrent password. Выбор торрентов и путь библиотеки сохранены; весь launcher.json не объявляется byte-identical после такой подготовки.
- Старый bundled offline Runtime и Compose-поставка удалены штатным NSIS cleanup. Общий WebView2 не удалялся.
- SHA256 всех **1514** файлов текущего WEB совпали с локальным build; на диске сохранены два дополнительных JSON metadata прежних Nuxt builds. Отчёт не заявляет точное равенство всего дерева installed directory.
- First start: пять настоящих page captures; **WebView2 155.0.4283.45**, **Runtime downloads=0**, **installer dispatches=0**.
- Tray/IPC: пользовательский SC_CLOSE скрыл окно, повторный запуск восстановил его с IPC exit 0; Node PID **8276** сохранился, PackageFlow PID **12832**, Session 1. API: busy:false/reasons:[]. Первый ранний tray-прогон завершился без отчёта; повтор после полной готовности PASS.

Повторное штатное обновление финальным кандидатом: NSIS 0, EXE/registry 1.10.15.0/1.10.15, final hashes совпали; все настройки и hashes пяти сохранённых WEB data files совпали до старта. После старта все четыре существовавших DPAPI-значения совпадают после расшифровки. Prowlarr ciphertext пересоздан с тем же значением. [Финальные live отчёты](evidence/windows-native-20261014/live/final/).

Первоначальные Native/UI тесты выявили две ошибки, исправленные до финальной сборки: Windows shared bind допускал занятый loopback (guard теперь `ExclusiveAddressUse=true`); скрытый WebView2 создавал проблему UI controller (контроллер создаётся видимым под нативной preparation-панелью, handle подготовлен). Native/UI/background harness PASS получены на первоначальном исправленном кандидате. После изменения только WEB deadline C#-код интерфейса не менялся; для финального EXE повторно проверены hashes, first start/Runtime counters, tray/IPC и изолированный packaged WEB.

[Реальные отчёты первого кандидата Windows](evidence/windows-native-20261014/live/pre-readiness-fix/), [снимки первого кандидата](../design/windows-native-20261014/installed-initial/), [Home финальной установки](../design/windows-native-20261014/installed/home.png). В JSON сохранены фактические boolean-сравнения ciphertext; смысловые сравнения DPAPI вынесены отдельно в `secrets-preservation.json`.

## Фоновые probes и согласованный WEB

Только 15-секундный health timer вызывает `RefreshHealth(background:true)` → `RefreshSavedConsoles(..., background:true)` → POST `/api/consoles/probe` с `background:true`. Обычные вызовы по умолчанию отправляют `{id}` без поля background. Явные Check, установочный координатор, preflight и проверка результата оставлены полными. Timeout/concurrency C# и прочие параметры скорости Windows launcher не менялись.

После первого update hardware preflight остановился до dispatch: idle full readiness отвечал за 3888ms, исходный deadline был 3500ms. Координирующий чат изменил только `/api/v1/install/readiness` deadline на **15000ms**; status/capabilities/system/pair сохраняют 3500ms, operation/batch deadlines не менялись. Все семь targeted tests, включая selective deadline regression, PASS. WEB и NSIS пересобраны, финальный кандидат установлен; размеры/SHA выше относятся к этой последней сборке.

Согласованный WEB включает lightweight background contract, generation/pid/build ограничения capabilities, dedup и TTL. WEB-файлы добавлены координирующим чатом; этот чат их не редактировал. Четыре targeted regression повторно PASS локально, остальные три подтверждены координатором. Source hashes двух WEB- и двух C#-файлов до/после полной WEB-сборки совпали. Server tree manifest: `evidence/windows-native-20261014/server-manifest.json`. В поставке stable ELF026f и app044; диагностический 026g не включён.

## Границы проверки

Реальная установка отсутствующего Runtime требует чистой Windows-среды; такой среды не было. Общий Runtime GAMEPAD-PC не удалялся. Missing dependency/error/retry/journal/no-replay ветви проверены Core integration fixtures с resolver/transport/process подменой; это не аппаратная установка Microsoft Runtime.

Linux build.sh выполнен полностью. Windows build.ps1 согласован по Native-only/pin/cleanup/audit/Node, но полный запуск на Windows не выполнен. Автоматическая проверка отклонила дополнительную передачу приватного WEB-манифеста и PowerShell build-исходников; этот необязательный экспорт пропущен. Разрешённая установка EXE успешно завершена. Ранние отказы передачи самого кандидата сняты прямым human answer в этом чате.

Коммитов, push, публикации релиза, сброса существующих изменений, установки на PS или игровых stress tests этим чатом не было. Аппаратные прогоны Battlefield выполнены координирующим чатом и зафиксированы ниже.

## Итог аппаратных прогонов Battlefield

По [общему журналу доказательств](evidence/ps5-battlefield-periodic-pauses-20261014.json), координирующий чат завершил три передачи через реальную очередь. Во всех прогонах errors пуст, отмена подтверждена до installer dispatch; частичные файлы собственных тестов удалены, прежняя пользовательская отменённая передача сохранена.

| Прогон | Сервис | Объём до отмены | Скорость по интервалам ACK* | Максимальный интервал ACK | Интервалы >3s |
|---|---|---:|---:|---:|---:|
| v2 | штатный 026f | 8 GiB | 77,60 MiB/s | 4,799s | 5 |
| v3 | временный диагностический 026g | 8 GiB | 91,61 MiB/s | 1,490s | 0 |
| v4 | штатный 026f | 4 GiB | 87,55 MiB/s | 2,438s | 0 |

*Скорость рассчитана между первым и последним подтверждением, без первого блока. Для v3 при отмене успел сохраниться ещё один находившийся в полёте блок 128 MiB; это не запуск установки.

В v2 один из семи background probes временно вернул offline/unpaired; максимальная задержка этого probe — 5179ms. В v3 все пять и в заключительном v4 все три probes сохраняли online/paired/deferred. В финальном прогоне на штатном сервисе периодических пауз >3s не наблюдалось; это не обещание отсутствия любых будущих скачков latency. Дополнительный trace collector v3 не собрал request traces из-за неверного status route; выводы v3/v4 основаны на ACK timestamps и batch profile, а не на новой trace-диагностике.

На PS5 восстановлен и оставлен **штатный 026f, PID 226**, SHA256 `2441b7ebe3aa6b265cb186512b5dd94f62666d40e16a71685d930c5b232a7732`. В Windows installer остаётся только 026f. Координирующий чат удалил свои девять диагностических Scheduled Tasks. Windows **PackageFlow PID 12832 / Node PID 8276** оставлены запущенными; дополнительных обновлений не выполнялось.
