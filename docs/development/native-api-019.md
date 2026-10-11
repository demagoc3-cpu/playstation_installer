# Codex: WEB/native API 019

Дата: 2026-10-11. WEB изменения подготовлены локально; нативные приложения не изменялись. API готов к интеграции Claude. Аппаратная проверка новых клиентских кнопок ещё не выполнена.

## Что изменилось

1. В v1/v2 command подключены `remove-items`, `remove-games`; PS4 — `stop-reinstall`. Действия используют точную приставку, историческую/текущую очередь и стабильные packageIds/branchIds. Квитанция сохраняется до действия, повтор исходного requestId читает результат, другое тело отклоняется. PS5 receipts больше не удаляются по количеству: старый повтор не должен стать новой командой.
2. Activity публикует `taskControls`, идентификаторы, права и доступную телеметрию. PS4 сохраняет legacy id=packageId, PS5 сохраняет opaque transfer id и отдельно packageId. Остановка выбранной переустановки использует maintenanceId.
3. В оба native каталога и activity добавлена возможность `installReview`. Новые read-only маршруты `POST /api/catalog/v1/install-preview` и v2 возвращают свежую проверку устройства, точный набор и installedPackages. `install-reviewed` принимает reviewToken и явные overwritePackageIds через существующий журнал команд и общий batch-установщик WEB. Никаких прямых удалений в приложении не требуется.
4. PS4 presence checker теперь принимает валидные девятисимвольные Title ID, включая SLES/SLUS/homebrew. Прежнее ограничение CUSA делало Disney’s Chicken Little невидимой для проверки переустановки. В журнале пользовательской попытки удаление было только у Broforce; SLES игра доходила до обычной установки и получала BGFT already-exists. Проверка неверного/неподтверждённого ID теперь не означает отсутствие игры.
5. Новые записи очистки истории привязаны к IP. Совпадение queueId/packageId у двух PS4 больше не скрывает новые записи обеих приставок. Прежние unscoped visibility keys читаются для совместимости.

Альтернативные пакеты одного патча с одинаковыми Content ID/версией могут пропускаться после подтверждения его установки. Это отличается от пропуска другой выбранной игры. Не выбранные пользователем игры и affected компоненты не добавляются в набор.

## Проверки

- Nuxt production build: PASS.
- Общая регрессия: 13 тестовых файлов (каталоги, старые команды, установка/переустановка, FW, очередь PS4/PS5, очистка, новый контракт). **13/13 PASS**, 77,47 с.
- `console-maintenance.test.ts`: 16/16 после корректировки старой fixture. Раньше её apps/title продолжал показывать установленную SLUS игру после подтверждённого удаления; теперь синтетический состав меняется после removal/install.
- `device-installed-review.test.mjs`: три выбранные игры, включая SLES, дают три отдельные удаления и три установки; невыбранная игра остаётся. Replay не отправляет команду удаления повторно.
- `native-task-contract.test.mjs`: историческая ветка более 50 строк, стабильный packageId PS5, защита принятых jobs, stop, exact scope, replay/conflict и uncertain после рестарта.
- Настоящий Nuxt HTTP v1/v2: PASS. Изолированная временная `.data` и синтетические службы. Проверены skip/replace для нескольких игр, SLES, неизменность невыбранной игры, outdated review без POST, stop exact flow, историческая очистка, две приставки с совпавшими ID, PS5 accepted-job protection, 403/415, replay и conflict.
- `git diff --check`: PASS.

Работающий WEB на `127.0.0.1:3000`: read-only GET v1 каталога вернул HTTP 200 и `installReview.version:1`, перезапуск не понадобился.

HTTP fixtures и снимки: `docs/development/native-api-019-examples/`. Build/logs: `/tmp/pf-native019-build-final.log`, `/tmp/pf-native019-regression-final.log`, `/tmp/pf-native019-http-final.log`.

## Передача Claude

Задание `CLAUDE-TASK-PS-APPS-019.md` обновлено: API реализован; включены parser/serializer, галочки/ветки/stop, install-preview и install-reviewed, строгая изоляция профиля, один POST при потерянном ответе, сохранение IME/навигации и требования host/SDK/HTTP-проверок. Реализовать в PS4 ui/ и PS5 experiments/native-ui, в отдельных сборочных копиях. Номера аппаратных кандидатов и отправка — Codex после отчёта Claude.

WEB/ELF-работа для этого контракта не требует новой полезной нагрузки. Пользовательские игры и сохранения для тестов не удалялись; рабочий WEB не перезапускался. Git commit/push WEB не выполнялся.
