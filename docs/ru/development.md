# API и разработка

[← Содержание](index.md) · [English](../en/development.md)

## HTTP API

<details>
<summary>Основные эндпоинты</summary>

| Группа | Эндпоинты |
|---|---|
| Консоль и очередь | `POST /api/ps4/status`, `GET /api/ps4/settings`, `GET` / `POST /api/ps4/installation`, `POST /api/ps4/installation/cancel`, `POST /api/ps4/launch`, `POST /api/ps4/queue` |
| PackageFlowService | `GET /api/ps4/service-status`, `GET /api/ps4/service-installer`, `POST /api/ps4/service-key` (сопряжение: `{ ip, code }`), `GET /api/ps4/system-info`, `GET /api/ps4/maintenance` |
| Обновление сервиса | `/api/ps4/service-update/*` — `check`, `github`, `package`, `install`, `restart`, `recover`, `reinstall`; раздача PKG приставке: `/service-update/manifest/:id.json`, `/service-update/package/:id.pkg` |
| На консоли | `GET /api/ps4/apps`, `details`, `icon`, `runtime`, `operation`; `POST /api/ps4/apps/remove`, `GET` / `POST /api/ps4/apps/control`; переустановка `GET` / `POST /api/ps4/reinstall` |
| Файлы консоли | `POST /api/ps4/files/list`, `POST /api/ps4/files/stat`, `GET /api/ps4/files/download`, `POST /api/ps4/files/upload/start`, `PUT …/chunk`, `POST …/finish` |
| Библиотека | `GET /api/packages`, `POST /api/packages/scan`, `POST /api/packages/select-directory`, `GET /api/packages/:id` (раздача PKG с `Range`, `?asset=icon`, `?asset=delivery`), `POST /api/packages/:id/installed`, `POST /api/packages/:id/reset`, `DELETE /api/packages/:id`, `DELETE /api/packages/branch?titleId=` |
| Манифест для BGFT | `GET /json/:id.json`, `GET /api/manifests/:id` |
| Торренты и поиск | `GET` / `POST /api/torrents/settings`, `GET /api/torrents`, `POST /api/torrents/add`, `POST /api/torrents/:hash/{pause,resume,delete,auto-install}`, `GET` / `POST /api/torrents/:hash/files`, `POST /api/torrents/:hash/library`, `GET` / `POST /api/search/settings`, `GET /api/search?q=` |
| Журнал | `GET /api/logs?after=`, `DELETE /api/logs` |

Команды к PackageFlowService WEB выполняет от своего имени с сохранённым ключом — браузеру ключ не выдаётся.

Приложение PS4 получает `GET /api/catalog/v1?lang=ru|en`: каталог библиотеки WEB, состав пакетов и ссылки на обложки (`mode: web-library`). Пути файлов и ключи службы не передаются; магнитные ссылки пока `null`. В приложении PackageFlow карточка позволяет установить все или выбранные пакеты через ту же очередь и PackageFlowService, что и WEB. PKG передаётся напрямую с WEB без предварительного копирования в файлы PS4. Переустановка использует существующие проверки и подтверждение удаления.

`POST /api/catalog/v1/command` сохраняет результат по уникальному requestId; GET этого адреса читает результат без повторной отправки. `GET /api/catalog/v1/activity?ip=...&source=install|web|local` показывает общие установки, задания qBittorrent WEB или явно ещё недоступный локальный торрент-клиент PS4. Для установки из библиотеки ПК WEB должен оставаться включённым. Эти маршруты используют прежние правила локального WEB; удалённый доступ через Интернет пока не реализован.

Исходники нативного меню находятся в отдельном проекте PackageFlowService (`ui/`); `experiments/catalog-ui` сохраняет старый тестовый вариант. В версии 1.65 интерфейс работает в 1920×1080 (Full HD), каталог показывает до десяти карточек: пять в ряд, два ряда. RU/EN сохраняется на PS4 в `/data/PackageFlowUI/language.txt`.

Раздел «Задания» показывает общую очередь и позволяет отменить текущий пакет либо всю очередь. Карточка игры предлагает установку всех или выбранных пакетов, только патчей или DLC. «Переустановить всё» после подтверждения удаляет прежнюю игру и устанавливает весь комплект по порядку: игра → патчи/бэкпорты → DLC. Ошибка удаления останавливает переустановку и возвращается в приложение; она не обозначается как принятая команда.

`GET /api/catalog/v1/support` передаёт публичные кошельки из настроек пожертвований WEB и матрицы QR-кодов. В разделе «Поддержать» на PS4 QR скрыты по умолчанию; показывается только выбранный код. 

</details>

## Структура проекта

```
playstation_installer/
├── app/
│   ├── app.vue                     # Интерфейс, боковое меню, библиотека, торренты, журнал
│   └── components/                 # На консоли, Файлы, О системе, обновление сервиса,
│                                   # способ установки и сопряжение, переустановка, пожертвования
├── server/
│   ├── api/                        # HTTP API (packages, ps4, torrents, search, logs)
│   ├── routes/                     # Манифесты BGFT и раздача обновлений сервиса
│   ├── plugins/                    # Автоустановка торрентов, журнал ошибок запросов
│   ├── utils/                      # Парсинг PKG, очередь, PyLoader, клиент PackageFlowService,
│   │                               # qBittorrent, Torznab, журнал, выбор папки
│   └── tests/                      # Тесты серверной логики
├── shared/types/                   # Общие типы клиента и сервера
├── public/ps4-pkg-installer.bin    # Payload для способа PyLoader (DirectPackageInstaller, GPL-3.0)
├── docs/screenshots/               # Скриншоты для README
├── nuxt.config.ts                  # В т.ч. BTC-адрес для раздела «Поддержать»
└── package.json
```

**Стек:** Nuxt 4, Vue 3, Nitro (Node.js), TypeScript; для QR‑кода — `uqr`.

### Разработка с приватным сервисом

WEB запускается и собирается без исходников PackageFlowService и OpenOrbis. Для интеграционного теста файлового API с исходниками отдельного сервиса укажите его каталог:

```sh
PACKAGEFLOW_SERVICE_SOURCE=/path/to/PackageFlowService node server/tests/console-files.test.mjs
```

Без переменной тест ищет соседний проект `../../PS/PackageFlowService`. Если приватного проекта нет, этот интеграционный тест пропускается. Явно заданный неверный путь вызывает ошибку. Инструкции сборки PKG находятся в README приватного проекта; готовые PKG продолжают распространяться через Releases WEB.
