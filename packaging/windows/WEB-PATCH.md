# Патч WEB для установленного launcher

Это отдельный формат от `package-windows-web.py` и старого
`update-windows-web.ps1`: они обслуживают standalone-каталог `web/`.
Новый патч заменяет только `server/.output` установленного PackageFlow и
независимый артефакт службы PS5. Он не собирает и не заменяет EXE, Node,
версию установленного launcher, старый console bundle или пользовательские
настройки. Никаких команд PS5 скрипт применения не отправляет.

## Независимая служба

В каталоге `PACKAGEFLOW_DATA_DIR`:

```text
ps5-service-artifacts/
  manifest.json
  <elf.sha256>/PackageFlowService-PS5.elf
```

`manifest.json` имеет строго следующий контракт:

```json
{
  "schemaVersion": 1,
  "elf": {
    "fileName": "PackageFlowService-PS5.elf",
    "size": 0,
    "sha256": "ЗНАЧЕНИЕ_ИЗ_ПРОВЕРЕННОГО_КАНДИДАТА",
    "version": "ВЕРСИЯ_КАНДИДАТА",
    "buildId": "BUILD_ID_КАНДИДАТА",
    "firmware": "13.60"
  }
}
```

Пример выше описывает поля и намеренно не является допустимым кандидатом.
Размер должен быть от 4096 до 4194304 байт. Подпапка выводится из SHA256;
путь из JSON не принимается. Артефакт не зависит от образа нативного приложения.
Его приоритет и отказ без fallback при повреждении реализует WEB reader.
Launcher 1.10.26 не перезаписывает этот каталог при старте.

## Подготовка

Все команды выполняются в изолированной копии. Упаковщик читает готовую
WEB-сборку; он не вызывает Nuxt, npm, Windows или PS5.

Для локальной копии точной установленной базы:

```sh
python3 scripts/package-windows-patch.py snapshot \
  --web /path/to/installed-copy/server/.output \
  --launcher /path/to/installed-copy/PackageFlow.exe \
  --launcher-version 1.10.26.0 \
  --node /path/to/installed-copy/runtime/node.exe \
  --output /path/to/base-snapshot.json
```

Версию в этом host-снимке задаёт вызывающий код. При применении скрипт
независимо сверяет настоящую FileVersion EXE. Альтернатива — read-only
снимок на Windows в том же JSON-формате: `schemaVersion:1`,
`kind:PackageFlowInstalledWindowsBase`, `launcher:{version,size,sha256}`,
`node:{size,sha256}`, `web:{files:[{path,size,sha256}],treeSha256}`.
Пути `web.files` относительны к `.output` и используют `/`.
Tree SHA256 считается по отсортированным ordinal путям UTF-8:
`path + TAB + decimalSize + TAB + sha256 + LF`.

Разместить одобренный ELF по заранее проверенному манифесту:

```sh
python3 scripts/package-windows-patch.py stage-service \
  --elf /path/to/approved/PackageFlowService-PS5.elf \
  --manifest /path/to/approved/service-manifest.json \
  --output /path/to/staged/ps5-service-artifacts
```

Упаковка:

```sh
python3 scripts/package-windows-patch.py package \
  --web /path/to/isolated/.output \
  --base-manifest /path/to/base-snapshot.json \
  --service-artifacts /path/to/staged/ps5-service-artifacts \
  --source-commit FULL_40_HEX_COMMIT \
  --archive /path/to/PackageFlow-WEB-patch.zip
```

Вывод содержит SHA256 ZIP и `patchId`, связывающий commit, SHA256 ELF и
SHA256 дерева WEB. Никакой предполагаемый hash/build ID не подставляется.
Существующий ZIP или каталог stage-service не перезаписывается.

ZIP содержит `patch-manifest.json`, `web/`, `ps5-service-artifacts/` и
`update-installed-windows-web.ps1`. Манифест фиксирует полные исходную и
новую WEB-сборки, launcher/Node базы и хеши всех файлов ZIP. Внутренние ссылки
Nitro материализуются; внешние/циклические ссылки, Windows-алиасы путей,
нативные `.node`-модули и неоднозначные имена отклоняются.

## Проверка и применение на Windows

Эти команды не являются разрешением запускать их на пользовательском ПК.
Аппаратное окно и конкретное применение согласуются отдельно.

Скрипт запускают Windows PowerShell 5.1+ в **той же интерактивной сессии и
под тем же пользователем**, что и работающий Node. SSH Session 0 отклоняется.
При необходимости удалённого применения нужен отдельно согласованный
InteractiveToken job. Скрипт сам не регистрирует и не останавливает задачи.

```powershell
$patchParameters = @{
  InstallDirectory = "$env:LOCALAPPDATA\Programs\PackageFlow"
  Archive = 'C:\path\PackageFlow-WEB-patch.zip'
  ArchiveSha256 = 'SHA256_ПОЛУЧЕННЫЙ_ОТ_УПАКОВЩИКА'
  ProbePath = @('Y:\')
}
.\update-installed-windows-web.ps1 @patchParameters
# Только после проверки и согласованного окна:
.\update-installed-windows-web.ps1 @patchParameters -Mode Apply -Execute
```

`Inspect` проверяет ZIP, полную базу, launcher/Node, конфигурацию, авторизованный
статус и принадлежность Node. Он не останавливает runtime. `ProbePath` —
доступные пути источников, которые новый Node должен суметь прочитать;
без переданных путей проверка mapped drives не заявляется.

Apply держит эксклюзивную блокировку, записывает журнал, готовит проверенный
ELF и использует штатный `/api/desktop/prepare-stop`. Только однозначный
HTTP 200 с `busy:true` и единственной причиной `request` разрешает следующий
drain: сервер уже отменил режим остановки после такого ответа. Ожидание
ограничено 12 POST и 20 секундами монотонного времени; timeout, неизвестный
результат, неверная структура ответа или другая причина busy прекращают
попытку без остановки процесса. Первый `busy:false` с пустым массивом причин
завершает повторы. Перед остановкой сверяются PID, creation time, executable,
owner и Session; lease должен быть строго меньше 10 секунд от начала этого
успешного POST, включая получение ответа и проверку процесса. Lease не продлевается.
Останавливается только принадлежащий приложению Node. Launcher и внешние
компоненты остаются работающими. Новый Node получает прежние настройки
портов, каталога данных и ключ текущего пользователя без вывода ключа.

Старая WEB-сборка, журнал и прежний независимый манифест сохраняются в:

```text
<InstallDirectory>/.web-patch-backups/<patchId>/
```

Скрипт не переписывает пользовательские JSON. Их хеши сверяются при
остановленном WEB; изменения после старта возвращаются отдельным списком
`stateDifferences` для проверки нормальных фоновых обновлений. Каталог
артефактов исключён из этого сравнения, поскольку он является целью патча.

Ошибка после остановки вызывает ограниченный откат в рамках того же запуска.
Работающий новый Node сначала должен пройти тот же stop guard. При потере
связи, busy или неоднозначном результате остаётся `needs-reconciliation`:
принудительного завершения и автоматического повтора нет. Успешно применённый
патч можно явно откатить той же командой с `-Mode Rollback -Execute`; перед
этим проверяются новый WEB, исходный backup и неизменность активного манифеста.
Старый манифест восстанавливается побайтово либо возвращается его отсутствие.
Новый бинарник может остаться неактивным в каталоге SHA256.

Существующий журнал запрещает повтор Apply. Частично выполненные или
неподтверждённые операции требуют проверки журнала, а не удаления guard-файлов.

## Host-проверки

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s scripts/tests -p 'test_windows_patch.py' -v
pwsh -NoProfile -NonInteractive -File scripts/tests/windows-patch-host.ps1
```

PowerShell host-тест загружает только определения функций через AST;
entry point updater не выполняется. Проверяются синтаксис, запрещённые
автоматические переменные, полные file inventories, переключение/возврат
манифеста, журнал, отказ busy/unknown до управления процессом и возврат
окружения после ошибки старта. Это не проверка Windows CIM/ACL/DPAPI,
реального перезапуска Node или аппаратной установки PS5.

Полный EXE готовится только после WEB-патча и аппаратной проверки. До этого
старые pins PS4 2.14 и PS5 app 01.000.044 не меняются; кандидат единой ELF
не выдаётся за уже опубликованную версию комплекта.
