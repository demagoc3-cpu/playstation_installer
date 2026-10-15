# Windows PackageFlow 1.10.15

Windows-приложение использует встроенные .NET (self-contained), Node.js/WEB и локальный Vue/WebView2 UI. В Windows нет запуска Docker/Compose, кнопки Docker Desktop или контейнерных настроек. Независимый Docker deployment основного WEB-проекта сохраняется отдельно.

## Сборка

Нужны Node 22 + npm, .NET SDK 8, NSIS. На Linux также Python 3, curl, unzip, awk и sha256sum.

```sh
PF_PS5_BUNDLE=/path/to/verified-console-bundle bash packaging/windows/build.sh --version 1.10.15
```

На Windows:

```powershell
./packaging/windows/build.ps1 -Version 1.10.15 -Ps5Bundle C:\verified-console-bundle
```

Версия Windows Node закреплена на 22.23.3 в обоих entrypoints; переопределения — `PF_NODE_VERSION` / `-NodeVersion`. `--skip-web-build` / `-SkipWebBuild` разрешены только после актуальной сборки `.output`; Vue всегда пересобирается отдельно через package-lock. Пути инструментов Linux: `PF_NPM_CLI`, `PF_DOTNET`, `PF_MAKENSIS`, `NSISDIR`. Параметров image/Compose больше нет.

Выход: `dist/windows/PackageFlowSetup-1.10.15-x64.exe` и SHA256. Версия реально компилируется, Windows/Core ссылки проверяются BundleCheck. `scripts/check-windows-payload.mjs` сверяет Desktop и все три PS-артефакта и запрещает старый offline Runtime, bootstrapper binary и файлы контейнерного запуска. Инкрементальная упаковка очищает эти прежние файлы в собственном build payload.

## WebView2 Runtime

Большой Evergreen Standalone Runtime и маленький bootstrapper **не входят в установщик**. При найденном подходящем Runtime (SDK, минимум 120.0.0.0, без preview suffix) загрузка/установка не выполняются. При отсутствии скачивается закреплённый официальный Microsoft bootstrapper (1 860 304 байт), который устанавливает Evergreen Runtime подходящей архитектуры. Bootstrapper проверяется по размеру, SHA256 и Authenticode Valid/Microsoft signer; HTTPS redirects ограничены сервером Microsoft. Файл удерживается открытым без права изменения до запуска.

До Vue отображается нативная панель проверки/загрузки/установки с честным прогрессом скачивания и неопределённым процентом работы Microsoft Setup. Код 0 недостаточен: SDK должен подтвердить Runtime. Ошибка сети, подписи, хэша, exit или повторной проверки оставляет понятную ошибку и ручной повтор/закрытие. Dispatch записывается до запуска. Timeout/неопределённый результат не завершают чужой Microsoft installer и не допускают повторный dispatch; доступна повторная проверка SDK или ручная установка Microsoft.

Интернет нужен только для первоначальной подготовки отсутствующей UI-зависимости и для явно включённых загрузок/внешних функций. Сам UI и assets локальные. Runtime нужен также при отказе от торрентов. Он не связан с Chromium/FlareSolverr. Setup запускается без UAC; Microsoft поддерживает per-user установку, но права и политики Windows могут её ограничить. [Microsoft distribution guidance](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution).

## Прежние контейнерные профили

`Mode=compose` читается как Native с обязательным review, без автоматического старта, adopt или остановки прежнего внешнего сервера. Перед сохранением исходный launcher.json резервируется целиком в `.pre-native-1.10.15.json`, включая неизвестные старые поля и DPAPI blobs. Библиотека, LAN/порты, ключи, пары, автозапуск и выбор торрентов сохраняются.

Для обновления закройте старый launcher и вручную завершите задания/остановите прежний WEB. Guard откажет на занятом порту и не отправит старому Compose launcher команду остановки. Новый UI предлагает обнаруженный bind-каталог либо полный экспорт `/app/.data` из Docker Desktop в папку Windows (со скрытыми файлами/ключами). Внешний volume напрямую не читается и не удаляется. После подтверждения создаётся отдельный импорт; исходник не меняется. Только известные `/games` и `/app/.data` пути переводятся в Windows; непереносимые локальные пути, повреждённый JSON, отсутствующий vault key и изменяющийся экспорт блокируют импорт. Remote-path внешнего qBittorrent и pairing keys сохраняются. Никакой пустой подмены external volume нет. Пустой **обнаруженный bind** допустим только с отдельным явным подтверждением отсутствия данных.

После импорта проверьте сетевые хранилища в WEB. Эта процедура не останавливает и не удаляет пользовательские контейнеры, Docker Desktop или volume и не выполняет prune.

## Компоненты и обновление

qBittorrent, Prowlarr, FlareSolverr и связанный Chromium не включены в EXE. Автоматическая докачка происходит только при согласованном выборе торрентов/поиска. Уже существующие компоненты и реальные методы RuTracker/CAPTCHA сохраняются.

В комплекте Windows 1.10.18: PS4 2.14, PS5 ELF 027 и новая ревизия PS5 app 01.000.044/6c32b25. Артефакты не пересобираются; размер, hashes и Build ID приложения проверяются. Комплект 1.10.17 сохраняет прежнюю ревизию 5122c1f. Обновление Windows не отправляет app044 на PS5 само по себе.

NSIS использует `--prepare-update`, проверяет jobs и не заменяет файлы при отказе guard. Удаляются только известные прежние файлы поставки Runtime/контейнерных build files по точным hashes в папке приложения. Общий Microsoft Runtime, пользовательские Downloads и volume не затрагиваются. Изменённый legacy-файл или symlink сохраняется, установка останавливается для ручной проверки.
