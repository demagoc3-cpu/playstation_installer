# Docker and NAS

[← Contents](index.md) · [Русский](../ru/docker.md)

The `demagoc3/packageflow` image supports amd64 and arm64. It contains the WEB runtime; Node.js installation and local compilation are unnecessary.

```sh
docker run -d --name packageflow --restart unless-stopped \
  --network host \
  -v packageflow-data:/app/.data \
  -v /path/to/games:/games:ro \
  demagoc3/packageflow:latest
```

Replace `/path/to/games` with the actual host folder. Open `http://<computer-IP>:3000` and scan **`/games`**. This is a path inside the container. Installing zenity on the host does not give a container a folder picker; Docker uses path entry.

The read-only library mount is supported: scan cache and covers are stored under `/app/.data`. Preserve the named data volume during updates. The provided [docker-compose.yml](../../docker-compose.yml) is an alternative; configure its host folders before running `docker compose up -d`.

Host networking is used so the console can reach WEB and the payload can connect back to the actual computer IP. The documented deployment targets Linux hosts/NAS/Raspberry Pi. For Windows/macOS, use the native Node setup; Docker Desktop has different VM/network behavior.

## Update

Run `docker pull demagoc3/packageflow:latest`, recreate the container with the same volume/mounts, or run `docker compose pull && docker compose up -d`. Removing the container does not remove the named data volume.

## qBittorrent paths

Mount its completed-download directory into PackageFlow too, for example `-v /srv/torrents:/downloads:ro`. Set the PackageFlow-visible path to `/downloads` and set the qBittorrent-visible path separately if it differs. See [torrent configuration](torrents.md).
