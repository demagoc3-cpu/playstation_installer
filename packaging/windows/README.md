# Локальная сборка Windows-установщика PackageFlow

**Русский** · [English](README.en.md)

Здесь описана сборка WEB и Windows-приложения в один установщик EXE. Команды выполняются на вашем компьютере из корня репозитория, где находятся `package.json` и каталог `packaging`.

Для локальной сборки используются текущие файлы, включая незакоммиченные изменения. Для сборки в GitHub Actions используются файлы, отправленные в выбранную ветку или тег.

## Что нужно

| Инструмент | Назначение |
| --- | --- |
| Node.js 22 и npm | Сборка WEB |
| .NET SDK 8 | Проверки и сборка Windows-приложения |
| NSIS 3 | Создание установщика |
| Интернет | Получение зависимостей и Windows Node.js |

На Linux дополнительно нужны Python 3, `curl`, `unzip`, `awk` и `sha256sum`. Перед сборкой скрипт проверяет инструменты и ищет их локальные установки. Docker требуется для проверки запуска Compose после сборки.

## Сборка на Windows

Откройте PowerShell в корне проекта. NSIS должен быть доступен как `makensis.exe` либо установлен в стандартную папку `Program Files (x86)/NSIS`.

```powershell
./packaging/windows/build.ps1 -Version 0.1.7

$setup = Get-Item './dist/windows/PackageFlowSetup-0.1.7-x64.exe'
$hash = (Get-FileHash $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $($setup.Name)" | Set-Content './dist/windows/SHA256SUMS.txt' -Encoding ascii
```

Сценарий сам установит зависимости WEB, соберёт WEB, выполнит проверки Windows-компонентов, соберёт `PackageFlow.exe`, загрузит Windows Node.js с проверкой SHA-256 и создаст установщик.

### Дополнительные варианты

```powershell
# Использовать уже собранный WEB из .output
./packaging/windows/build.ps1 -Version 0.1.7 -SkipWebBuild

# Подготовить полный комплект приложения без упаковки Setup.exe
./packaging/windows/build.ps1 -Version 0.1.7 -SkipInstaller

# Задать имя локального образа для режима Compose
./packaging/windows/build.ps1 -Version 0.1.7 -DockerImage packageflow:local
```

`-SkipWebBuild` используйте после успешной сборки актуального WEB. `-DockerImage` задаёт имя образа, который мастер создаст из готового WEB при запуске Compose; эта команда не публикует образ в реестр.

## Сборка Windows EXE на Linux

.NET собирает Windows-приложение на Linux благодаря `EnableWindowsTargeting` в проекте. Запуск WinForms-интерфейса проверяется на Windows. Сценарий `build.ps1` рассчитан на Windows. На Linux запускайте `packaging/windows/build.sh`: он сам найдёт корень проекта и подготовит установщик.

Проверьте инструменты, затем запустите сборку:

```bash
bash packaging/windows/build.sh --check
bash packaging/windows/build.sh --version 0.1.7
```

В корне проекта также есть короткий запуск `bash build-local.sh`. Его можно запускать из IDE: рабочая папка определяется автоматически.

Если зависимости уже установлены, используйте `--skip-install`. Для актуального готового WEB доступен `--skip-web-build`, для подготовки комплекта без EXE установщика — `--skip-installer`.

```bash
bash build-local.sh --skip-install
```

Скрипт ищет npm в PATH, каталогах pnpm, nvm и fnm. .NET ищется в PATH, `.toolchains/dotnet`, `~/.dotnet` и временном каталоге нашей тестовой сборки. NSIS ищется в PATH, `.toolchains/nsis` и временном каталоге тестовой сборки. Временные каталоги могут исчезнуть после перезагрузки: для постоянной работы установите инструменты либо разместите их в `.toolchains`.

Свои пути задавайте переменными `PF_NPM_CLI` (путь к `npm-cli.js`), `PF_DOTNET`, `PF_MAKENSIS` и при необходимости `NSISDIR`. Версию Windows Node.js можно задать через `PF_NODE_VERSION`; по умолчанию используется проверенная в нашей сборке **22.23.3**. Имя локального образа Compose задаётся через `PF_DOCKER_IMAGE`.

Перед упаковкой скрипт дожидается завершения сборки, скачивает официальный Windows Node.js и проверяет SHA-256. Полный код находится в [build.sh](build.sh).

## Где находится результат

| Файл или каталог | Содержимое |
| --- | --- |
| `dist/windows/PackageFlowSetup-0.1.7-x64.exe` | Установщик для передачи пользователям |
| `dist/windows/SHA256SUMS.txt` | Контрольная сумма установщика |
| `dist/windows/payload/PackageFlow.exe` | Windows-приложение запуска и настройки |
| `dist/windows/payload/server/.output/` | Готовая сборка WEB |
| `dist/windows/payload/runtime/` | Windows Node.js |
| `dist/windows/payload/compose/` | Файлы для запуска Compose |

Для запуска распакованного комплекта на Windows открывайте `PackageFlow.exe` внутри полного каталога `payload`. Для передачи обычным пользователям используйте `PackageFlowSetup-…-x64.exe`.

Prowlarr и FlareSolverr загружаются мастером при настройке поиска. Docker Desktop и qBittorrent устанавливаются пользователем отдельно. PKG службы PS4 собирается в репозитории PackageFlowService.

## Проверка

Основные проверки Windows-компонентов уже выполняются при сборке. Проверить обмен адресом WEB при сопряжении можно отдельно:

```bash
node --test server/tests/service-pairing.test.mjs server/tests/service-web-address.test.mjs
```

При наличии Docker с Compose можно проверить упакованный WEB и сохранение данных в контейнере:

```bash
python3 packaging/compose/smoke.py --dotnet dotnet
```

Этот тест использует подготовленный каталог `payload`, запускает отдельный временный проект Compose и очищает его контейнеры после проверки.

На Windows проверьте установку поверх предыдущей версии, запуск и трей, сопряжение с PS4, поиск с FlareSolverr и выбранный режим запуска. Успешная сборка EXE не подтверждает поведение окна на реальной Windows.

## Если сборка остановилась

- **Инструмент не найден:** проверьте `node --version`, `npm --version`, `dotnet --info` и наличие NSIS в PATH.
- **Не скачались зависимости:** проверьте интернет и сообщения npm/.NET; повторите сборку после устранения причины.
- **Ошибка SHA-256 Node.js:** остановите упаковку и повторно скачайте официальный архив и список контрольных сумм.
- **Обнаружены файлы `.node`:** нужны отдельные сборки таких модулей для Windows и Linux/Compose; упаковщик останавливается вместо включения несовместимых модулей.
- **Версия отклонена:** используйте три числа, например `0.1.1`.

Собранные файлы находятся в `dist`, который исключён из Git. Для публикации добавьте установщик и контрольную сумму в GitHub Release вручную.

## Проверка Cloudflare на Windows

На вкладке установки есть настройка **«Cloudflare: видимый браузер FlareSolverr (Windows)»**. Она включена по умолчанию, в том числе после обновления старых настроек. Во время проверки трекера может открываться Chromium; если появится галочка проверки, её можно нажать. Язык диагностического браузера — английский, интерфейс PackageFlow сохраняет выбранный язык.

Скрытый браузер FlareSolverr 3.5.2 на тестовой Windows-машине не проходил проверку RuTracker и возвращал пустые cookies либо страницу Cloudflare. Видимый браузер с `LANG=en-US` получил форму входа и cookies, с которыми HTTP-запрос вернул `200`. Авторизация и поиск дополнительно проверяются Prowlarr; доступность главной страницы не подтверждает вход.

Чтобы изменить режим у уже запущенного мастера, остановите сервер, поменяйте галочку и нажмите **«Сохранить и запустить»**. Настройка относится к управляемому FlareSolverr в режиме Windows. Внешний FlareSolverr и контейнер Compose она не перенастраивает.
