# Установка и запуск WEB

[← Содержание](index.md) · [English](../en/getting-started.md)

## Требования

### Компьютер

| Компонент | Версия / примечание |
|---|---|
| ОС | Windows, Linux, macOS |
| Node.js | **20.19+** или **22 LTS** (требование Nuxt 4) |
| Пакетный менеджер | `pnpm` (рекомендуется) или `npm` |
| Диалог выбора папки | Windows и macOS — встроенный; Linux — `zenity` или `kdialog` (опционально) |
| qBittorrent | Опционально, 4.2+ с включённым Web UI (поддерживаются и 5.x) |
| Сеть | ПК и PS4 в одной локальной сети |

### PlayStation 4

- Прошивка с поддержкой эксплойта и загруженным **GoldHEN**.
- Для способа **PackageFlowService** — установленный PKG сервиса (см. [ниже](ps4-app.md)).
- Для способа **PyLoader** — загрузчик payload, который слушает TCP `9090` и отвечает на `GET /status` → `{"status":"ready"}`.
- Достаточно свободного места: для установки игры нужно примерно вдвое больше размера PKG.

## Установка

```bash
# 1. Клонировать репозиторий
git clone https://github.com/demagoc3-cpu/playstation_installer.git
cd playstation_installer

# 2. Установить зависимости
pnpm install          # или: npm install

# 3. (Linux, опционально) диалог выбора папки — на Windows и macOS не нужен
sudo apt install zenity          # Debian / Ubuntu
sudo dnf install zenity          # Fedora
sudo pacman -S zenity            # Arch
```

> Если `pnpm install` ругается на `pnpm-workspace.yaml`, замените строку
> `esbuild: set this to true or false` на `esbuild: true`.

### Открыть порты в файрволе

Консоль сама подключается к ПК, поэтому входящие соединения из LAN должны быть разрешены:

- **TCP 3000** — веб‑интерфейс, манифесты и раздача PKG;
- **TCP, случайный высокий порт** — обратное подключение payload (порт выбирается ОС при каждом запуске).

Пример для `ufw` (разрешить всё из домашней подсети):

```bash
sudo ufw allow from 192.168.1.0/24
```

Для `firewalld`:

```bash
sudo firewall-cmd --permanent --zone=trusted --add-source=192.168.1.0/24
sudo firewall-cmd --reload
```

## Запуск

### Режим разработки

```bash
pnpm dev
```

Сервер слушает `0.0.0.0:3000` (см. `nuxt.config.ts`). Откройте `http://localhost:3000`.

### Продакшен‑сборка

```bash
pnpm build
HOST=0.0.0.0 PORT=3000 node .output/server/index.mjs
```

> Запускайте сервер **из корня проекта**: пути к payload (`public/` или `.output/public/`) и к папке данных `.data/` вычисляются от текущего каталога.

### Автозапуск через systemd (Linux)

`/etc/systemd/system/packageflow.service`:

```ini
[Unit]
Description=PackageFlow PS4 installer
After=network-online.target

[Service]
Type=simple
User=developer
WorkingDirectory=/home/developer/projects/web/playstation_installer
Environment=HOST=0.0.0.0
Environment=PORT=3000
ExecStart=/usr/bin/node .output/server/index.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now packageflow
```
