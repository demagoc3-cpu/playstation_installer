# qBittorrent downloads

[← Contents](index.md) · [Русский](../ru/torrents.md)

PackageFlow controls qBittorrent through its Web UI API. It may run on the same computer, a NAS, another LAN computer or Docker. Completed files must be accessible to the PackageFlow server.

## Install qBittorrent

On Debian/Ubuntu use `sudo apt install qbittorrent` for a desktop or `sudo apt install qbittorrent-nox` for a headless server. Fedora/Arch use their package managers. Windows/macOS installers are available from [qBittorrent](https://www.qbittorrent.org/download).

Start `qbittorrent-nox` once and accept its terms. Read the username/temporary password from its console. Debian/Ubuntu can use `sudo systemctl enable --now qbittorrent-nox@$USER` when the packaged template exists. The Russian guide also includes a [Docker example](../ru/torrents.md).

## Enable and connect Web UI

In qBittorrent settings enable Web UI, select the address/port (often 8080), and set credentials. In PackageFlow → Downloads → Configure, enter the full URL, username, password and the download directory as seen by PackageFlow. Save and check the connection.

For qBittorrent on a NAS or another computer, mount/share its completed-download directory on the WEB computer. If the paths differ, enter both:

| Field | Example |
|---|---|
| Download folder on this PC / PackageFlow | `/mnt/nas/downloads` |
| Same folder in qBittorrent | `/downloads` |

These must refer to the same files. If qBittorrent runs in Docker, mount the download directory into PackageFlow as well. See [Docker](docker.md).

## Download and install

Paste an authorized magnet or HTTPS torrent URL. Enable Install after download if desired, then Download. Controls include pause/resume, file priorities and auto-install. Removing a torrent task from PackageFlow does not delete its downloaded files.

After completion, selected PKGs are scanned/imported and installed through the configured default installer. Keep WEB running and the download folder mounted. The PS4 native app's WEB Downloads tab displays these same tasks. The Local PS4 tab remains a placeholder: PS4 does not torrent-download these tasks itself.

Passwords are stored in `.data/qbittorrent.json` as plain text; protect the data directory and preserve it when updating.
