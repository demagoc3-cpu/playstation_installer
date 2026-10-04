# Docker и NAS

[← Содержание](index.md) · [English](../en/docker.md)

## Запуск в Docker

Готовый образ: [`demagoc3/packageflow`](https://hub.docker.com/r/demagoc3/packageflow) для `amd64` и `arm64`, подходит для Linux‑ПК, NAS и Raspberry Pi. Node.js и сборка не нужны.

```bash
docker run -d --name packageflow --restart unless-stopped \
  --network host \
  -v packageflow-data:/app/.data \
  -v /path/to/games:/games:ro \
  demagoc3/packageflow:latest
```

Или скачайте [`docker-compose.yml`](../../docker-compose.yml), укажите в нём папку с играми и выполните `docker compose up -d`.

Откройте `http://<IP компьютера>:3000`, нажмите **«Выбрать папку»** и впишите **`/games`**. В Docker эта кнопка открывает ввод пути внутри контейнера. Системное окно выбора папки и установка `zenity` для Docker не нужны.

Папка с PKG может быть подключена только для чтения (`:ro`): кэш сканирования и обложки сохраняются отдельно в томе `/app/.data`.

`--network host` обязателен: PS4 сама скачивает пакеты с компьютера и подключается к нему обратно, поэтому контейнер должен работать в сети компьютера и отдавать консоли его настоящий IP. Адрес определяется автоматически, ничего прописывать не нужно.

> Образ рассчитан на Linux (ПК, NAS, Raspberry Pi). В Docker Desktop на Windows и macOS контейнер работает внутри виртуальной машины, и консоль до него не достучится. Там запускайте PackageFlow без Docker, по разделу [Установка](getting-started.md).

### Обновление

```bash
docker pull demagoc3/packageflow:latest
docker rm -f packageflow   # данные остаются в томе packageflow-data
# и снова команда docker run выше (или: docker compose pull && docker compose up -d)
```

### qBittorrent и Docker

Если qBittorrent тоже работает в Docker, смонтируйте его папку загрузок в PackageFlow, например `-v /srv/torrents:/downloads:ro`. В настройках торрент‑клиента укажите в поле «Папка загрузок на этом ПК» путь `/downloads`, а в поле «Та же папка в qBittorrent» путь, под которым эту папку видит qBittorrent. Схема та же, что в разделе [qBittorrent на другом компьютере](torrents.md#qbittorrent-на-другом-компьютере-nas-сервер).
