# PackageFlow для Linux: сборка .deb и AppImage

Сборка лежит рядом с Windows (`packaging/windows`) и берёт всё из этого репозитория:

- WEB — `npm ci` и `npm run build` в корне (`.output`);
- оболочка рабочего стола (трей, окно, служба systemd, мастер поиска) — `apps/linux-desktop`;
- комплект для приставок — каталог с `manifest.json`, ELF службы PS5, приложением PS5 и PKG службы PS4.
  Он должен совпадать с `packaging/windows/console-bundle-<версия>.json`;
- Node.js linux-x64 проверяется по SHASUMS256 с nodejs.org, среда AppImage — по SHA-256 из `pins.json`.

```bash
PF_PS5_BUNDLE=/путь/к/console-bundle python3 packaging/linux/build.py --version 1.10.28
```

Результат: `dist/linux/packageflow_<версия>-1_amd64.deb`, `dist/linux/PackageFlow-<версия>-x86_64.AppImage`
и `dist/linux/SHA256SUMS`. `--skip-web-build` использует уже собранный `.output`.

Нужны: Node.js 22, python3-gi с GdkPixbuf и librsvg (иконки), `squashfs-tools`, `dpkg-deb`.
Не запускайте сборку в каталоге, где работает dev-сервер Nuxt: они делят `.nuxt`.

## GitHub Actions

`.github/workflows/linux.yml` (как `windows.yml`) запускается по тегу `v*` или вручную.
Комплект берётся из релиза `console-bundle-<версия>` (`scripts/fetch-console-bundle.mjs`)
и сверяется с закреплённым манифестом. Перед сборкой релиза приложите к релизу
`console-bundle-<версия>` файлы из `manifest.json`.
