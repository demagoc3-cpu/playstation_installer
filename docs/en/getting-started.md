# Install and start WEB

[← Contents](index.md) · [Русский](../ru/getting-started.md)

## Requirements

Windows, Linux or macOS; Node.js 20.19+ or a supported 22 LTS version; pnpm or npm. PS4 and the computer must be on the same LAN, with HEN active and enough free console space. PackageFlowService is the default installer. PyLoader listening on TCP 9090 is optional.

## Install

```sh
git clone https://github.com/demagoc3-cpu/playstation_installer.git
cd playstation_installer
pnpm install
```

`npm install` also works. On Linux, an optional native folder picker uses zenity or kdialog; on Windows/macOS the OS picker is built in. Debian/Ubuntu: `sudo apt install zenity`; Fedora: `sudo dnf install zenity`; Arch: `sudo pacman -S zenity`. You can enter a folder path instead.

## Start

Development:

```sh
pnpm dev
```

Production:

```sh
pnpm build
HOST=0.0.0.0 PORT=3000 node .output/server/index.mjs
```

Run from the repository root: `.data` and payload paths are resolved from the current working directory. Open `http://localhost:3000` on the computer. PS4 must reach the computer's LAN IP, not localhost.

Allow TCP 3000 from your LAN. PyLoader also needs the payload's return connection on a dynamically assigned high TCP port. For a trusted subnet, an example is `sudo ufw allow from 192.168.1.0/24`; replace the subnet with your actual LAN.

## Linux autostart

Create `/etc/systemd/system/packageflow.service`, using your actual user, repository path and Node binary:

```ini
[Unit]
Description=PackageFlow PS4 installer
After=network-online.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/playstation_installer
Environment=HOST=0.0.0.0
Environment=PORT=3000
ExecStart=/usr/bin/node .output/server/index.mjs
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Run `sudo systemctl daemon-reload` and `sudo systemctl enable --now packageflow`. Continue with [PS4 pairing](ps4-app.md) and [library scanning](library.md).
