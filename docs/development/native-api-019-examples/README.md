# Native API 019 — примеры реальных HTTP-ответов

Дата: 2026-10-11. Получены тестом `server/tests/native-api-http.test.mjs` через production-маршруты собранного Nuxt. Службы приставок симулируются, данные лежат в временной `.data`. Исходные игры и production `.data` не используются.

## Файлы

- `ps4-activity.json`, `ps5-activity.json`: стабильные packageId, branchId, права очистки, taskControls и installReview. PS5 opaque id отличается от packageId; принятый unconfirmed job остаётся видимым.
- `ps4-install-preview.json`: две уже установленные игры (CUSA и SLES) и одна новая. Выбор фиксирован в selection.packageIds.
- `ps4-install-reviewed-command.json`, `ps4-install-reviewed-receipt.json`: следующий обзор после установки новой игры, явный выбор трёх переустановок и квитанция accepted. Токен команды относится к этому следующему обзору, а не к ранее сохранённому preview.
- `ps5-install-preview.json`, `ps5-install-reviewed-command.json`, `ps5-install-reviewed-receipt.json`: существующий PKG и пропуск при пустом overwritePackageIds.

Значения requestId/reviewToken/ревизий/профилей тестовые и не подходят для настоящих приставок. Квитанции подтверждают команды; installed подтверждается только последующим activity. Запуск теста повторно генерирует новые UUID и timestamps.

## Воспроизведение

После Nuxt build, используя Node 24:

```sh
PF_NATIVE_HTTP_CAPTURE_DIR=docs/development/native-api-019-examples node server/tests/native-api-http.test.mjs
```

Тест запускает отдельный сервер только на 127.0.0.1, изолирует данные и прекращает его после проверки. В native приложениях: сначала fixtures для parser/serializer, затем HTTP-интеграция реального клиента; проверка на приставке отдельная.
