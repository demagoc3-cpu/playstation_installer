"""Automatic search setup: qBittorrent, Prowlarr, FlareSolverr and RuTracker (as the Windows launcher does).

Components come from their official GitHub releases (verified size + GitHub SHA-256),
are unpacked into ~/.local/share/PackageFlow/components (no FUSE at run time) and run as
systemd user services bound to packageflow.service. FlareSolverr's Linux release carries
its own Chromium; a hidden browser needs Xvfb, otherwise its window is shown.
"""
from __future__ import annotations

import base64
import hashlib
import http.cookiejar
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import tarfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import api, paths, service, updates
from . import settings as cfg
from .prowlarr import Prowlarr, ProwlarrError

QBIT_USER = "packageflow"
QBIT_CONFIGURATION = "PackageFlow"
PROWLARR_URL = "http://127.0.0.1:9696"
FLARE_URL = "http://127.0.0.1:8191/"
RELEASES = {
    # Headless qbittorrent-nox (static build of the official sources, linked from the qBittorrent wiki):
    # the official Linux AppImage is the GUI client and has no windowless Qt platform.
    "qbittorrent": ("userdocs/qbittorrent-nox-static", re.compile(r"^x86_64-qbittorrent-nox$")),
    "prowlarr": ("Prowlarr/Prowlarr", re.compile(r"^Prowlarr\.master\.([\d.]+)\.linux-core-x64\.tar\.gz$")),
    "flaresolverr": ("FlareSolverr/FlareSolverr", re.compile(r"^flaresolverr_linux_x64\.tar\.gz$")),
}

Report = Callable[[str, str], None]  # (step, message)


class SetupError(RuntimeError):
    pass


class CaptchaRequired(SetupError):
    pass


class ProwlarrKeyRequired(SetupError):
    pass


# ---------------------------------------------------------------- state

def state_path() -> Path:
    return paths.config_dir() / "search.json"


def load_state() -> dict:
    try:
        return json.loads(state_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(s: dict) -> None:
    cfg._atomic_write(state_path(), json.dumps(s, ensure_ascii=False, indent=2), 0o600)


def components_dir() -> Path:
    return paths.data_home() / "components"


# ---------------------------------------------------------------- downloads

def latest_asset(name: str) -> updates.Asset:
    repo, pattern = RELEASES[name]
    req = urllib.request.Request(f"https://api.github.com/repos/{repo}/releases/latest",
                                 headers={"User-Agent": "PackageFlow-Linux/1", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            rel = json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise SetupError(f"{name}: не удалось получить выпуск из GitHub ({e})") from e
    prefix = f"https://github.com/{repo}/releases/download/"
    for a in rel.get("assets") or []:
        n, url, digest, size = a.get("name", ""), a.get("browser_download_url", ""), a.get("digest") or "", a.get("size") or 0
        if pattern.match(n) and url.startswith(prefix) and url.endswith("/" + n) \
                and re.match(r"^sha256:[0-9a-fA-F]{64}$", digest) and 0 < size <= updates.MAX_SIZE:
            return updates.Asset(name, rel.get("tag_name", ""), (), n, url, size, digest[7:].lower())
    raise SetupError(f"{name}: в последнем выпуске {repo} нет проверяемой сборки для Linux x64")


def _unpack(name: str, asset: updates.Asset, progress: Callable[[int], None] | None) -> Path:
    target = components_dir() / name
    downloads = paths.state_dir() / "downloads"
    file = updates.download(asset, downloads / asset.name, progress)
    staging = components_dir() / f".{name}.staging-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    try:
        if not asset.name.endswith((".tar.gz", ".tgz")):  # a single executable
            shutil.copyfile(file, staging / "qbittorrent-nox")
            (staging / "qbittorrent-nox").chmod(0o755)
        else:
            with tarfile.open(file) as t:
                t.extractall(staging, filter="data")
        (staging / ".version").write_text(asset.version, encoding="utf-8")
        shutil.rmtree(target, ignore_errors=True)
        os.replace(staging, target)
    finally:
        shutil.rmtree(staging, ignore_errors=True)
        file.unlink(missing_ok=True)
    return target


def _find(root: Path, filename: str) -> Path | None:
    hits = [p for p in root.rglob(filename) if p.is_file() and os.access(p, os.X_OK)]
    return min(hits, key=lambda p: len(p.parts)) if hits else None


CHROME_WRAPPER = """#!/bin/sh
# PackageFlow: FlareSolverr is a PyInstaller bundle and passes LD_LIBRARY_PATH=_internal to the
# browser it starts; its old bundled X11/GLib libraries crash Chromium's renderer on newer systems
# ("Unable to receive message from renderer"). Give the browser the system libraries back, and use
# stable Chrome for Testing: the Chromium 153 dev build bundled with FlareSolverr 3.5.2 does not pass
# RuTracker's Cloudflare check, stable Chrome does (as the Debian Chromium in FlareSolverr's Docker image).
if [ -n "${LD_LIBRARY_PATH_ORIG+x}" ]; then export LD_LIBRARY_PATH="$LD_LIBRARY_PATH_ORIG"; else unset LD_LIBRARY_PATH; fi
exec @TARGET@ "$@"
"""
CFT_JSON = "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json"
CFT_PREFIX = "https://storage.googleapis.com/chrome-for-testing-public/"


def patch_flaresolverr_chrome(root: Path, target: Path | None = None) -> bool:
    """Puts CHROME_WRAPPER in place of the bundled chrome (kept as chrome.real). True when changed."""
    chrome = next((p for p in root.rglob("chrome") if p.is_file() and p.parent.name == "chrome"), None)
    if chrome is None:
        return False
    with chrome.open("rb") as f:
        if f.read(4) == b"\x7fELF":
            os.replace(chrome, chrome.with_name("chrome.real"))
    exe = f'"{target}"' if target else '"$(dirname "$(readlink -f "$0")")/chrome.real"'
    text = CHROME_WRAPPER.replace("@TARGET@", exe)
    if chrome.exists() and chrome.read_text(encoding="utf-8", errors="replace") == text:
        return False
    chrome.write_text(text, encoding="utf-8")
    chrome.chmod(0o755)
    return True


def ensure_chrome(report: Report, progress: Callable[[int], None] | None = None) -> Path:
    """Stable Chrome for Testing (Google's official automation build) in components/chrome-for-testing/<ver>."""
    base = components_dir() / "chrome-for-testing"
    installed = sorted((p for p in base.glob("*/chrome-linux64/chrome") if p.is_file()),
                       key=lambda p: [int(x) for x in p.parent.parent.name.split(".") if x.isdigit()]) if base.exists() else []
    if installed:
        return installed[-1]
    report("flaresolverr", "Загружаем стабильный Chrome for Testing для FlareSolverr…")
    try:
        with urllib.request.urlopen(urllib.request.Request(CFT_JSON, headers={"User-Agent": "PackageFlow-Linux/1"}),
                                    timeout=20) as r:
            stable = json.loads(r.read().decode("utf-8"))["channels"]["Stable"]
        version = stable["version"]
        url = next(d["url"] for d in stable["downloads"]["chrome"] if d["platform"] == "linux64")
    except (OSError, ValueError, KeyError, StopIteration) as e:
        raise SetupError(f"Chrome for Testing: не удалось получить стабильную версию ({e})") from e
    if not re.fullmatch(r"\d+(\.\d+){3}", version) or url != f"{CFT_PREFIX}{version}/linux64/chrome-linux64.zip":
        raise SetupError("Chrome for Testing: неожиданный адрес загрузки")
    head = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "PackageFlow-Linux/1"})
    with urllib.request.urlopen(head, timeout=20) as r:
        size = int(r.headers.get("Content-Length") or 0)
        md5 = next((h.split("=", 1)[1] for v in r.headers.get_all("x-goog-hash") or [] for h in v.split(",")
                    if h.strip().startswith("md5=")), "").strip()
    if not size or not md5:
        raise SetupError("Chrome for Testing: Google Storage не сообщил размер и контрольную сумму")
    downloads = paths.state_dir() / "downloads"
    downloads.mkdir(parents=True, exist_ok=True)
    zpath = downloads / f"chrome-for-testing-{version}.zip"
    h, total, last = hashlib.md5(), 0, -1
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "PackageFlow-Linux/1"}),
                                    timeout=60) as r, zpath.open("wb") as f:
            while block := r.read(1 << 20):
                total += len(block)
                h.update(block)
                f.write(block)
                if progress and total * 100 // size != last:
                    last = total * 100 // size
                    progress(last)
        if total != size or base64.b64encode(h.digest()).decode() != md5:
            raise SetupError("Chrome for Testing: размер или контрольная сумма не совпали с Google Storage")
        staging = base / f".{version}.staging-{os.getpid()}"
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        import zipfile
        with zipfile.ZipFile(zpath) as z:
            for info in z.infolist():
                target = (staging / info.filename).resolve()
                if not str(target).startswith(str(staging.resolve()) + os.sep):
                    raise SetupError("Chrome for Testing: небезопасный путь в архиве")
                z.extract(info, staging)
                mode = (info.external_attr >> 16) & 0o777
                if mode and not info.is_dir():
                    target.chmod(mode)
        final = base / version
        shutil.rmtree(final, ignore_errors=True)
        os.replace(staging, final)
    finally:
        zpath.unlink(missing_ok=True)
        for st in base.glob(f".{version}.staging-*"):
            shutil.rmtree(st, ignore_errors=True)
    chrome = base / version / "chrome-linux64" / "chrome"
    if not chrome.is_file():
        raise SetupError("Chrome for Testing: chrome не найден после распаковки")
    return chrome


def ensure_component(name: str, progress: Callable[[int], None] | None = None) -> Path:
    if name == "qbittorrent" and shutil.which("qbittorrent-nox"):
        return Path(shutil.which("qbittorrent-nox"))
    exe_name = {"qbittorrent": "qbittorrent-nox", "prowlarr": "Prowlarr", "flaresolverr": "flaresolverr"}[name]
    root = components_dir() / name
    exe = _find(root, exe_name) if root.exists() else None
    if exe is None:
        exe = _find(_unpack(name, latest_asset(name), progress), exe_name)
    if exe is None:
        raise SetupError(f"{name}: исполняемый файл не найден после распаковки")
    return exe


# ---------------------------------------------------------------- running components

def port_free(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.3)
        return s.connect_ex(("127.0.0.1", port)) != 0


def unit_name(name: str) -> str:
    return f"packageflow-{name}.service"


def component_unit(name: str, argv: list[str], env: dict[str, str], cwd: Path) -> str:
    lines = [f'Environment="{k}={v}"' for k, v in env.items()]
    return "\n".join([
        "[Unit]", f"Description=PackageFlow {name}", "PartOf=packageflow.service",
        "After=network-online.target", "", "[Service]", "Type=exec",
        f"ExecStart={service.quote_exec(argv)}", f"WorkingDirectory={cwd}", *lines,
        "Restart=on-failure", "RestartSec=10", "TimeoutStopSec=30", "",
        "[Install]", "WantedBy=packageflow.service", "",
    ])


def run_component(name: str, argv: list[str], env: dict[str, str], cwd: Path) -> None:
    if service.available():
        path = paths.user_unit_dir() / unit_name(name)
        text = component_unit(name, argv, env, cwd)
        path.parent.mkdir(parents=True, exist_ok=True)
        changed = not path.exists() or path.read_text(encoding="utf-8") != text
        if changed:
            path.write_text(text, encoding="utf-8")
            service.systemctl("daemon-reload")
        service.systemctl("enable", unit_name(name))
        service.systemctl("restart" if changed else "start", unit_name(name))
        return
    # Without systemd (tests, containers): a detached child with its own log.
    log = paths.state_dir() / f"{name}.log"
    log.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.Popen(argv, cwd=cwd, env={**os.environ, **env}, stdout=log.open("ab"),
                            stderr=subprocess.STDOUT, start_new_session=True)
    s = load_state()
    s.setdefault("pids", {})[name] = proc.pid
    save_state(s)


def stop_component(name: str) -> None:
    if service.available():
        service.systemctl("stop", unit_name(name), check=False)
        return
    pid = load_state().get("pids", {}).get(name)
    if pid:
        try:
            os.killpg(pid, 15)
        except OSError:
            pass


def wait_until(check: Callable[[], bool], seconds: int, what: str) -> None:
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(1)
    raise SetupError(f"{what} не запустился за {seconds} с. Журнал: «Журнал службы» или ~/.local/state/PackageFlow")


# ---------------------------------------------------------------- qBittorrent

def qbit_profile() -> Path:
    return paths.data_home() / "qbittorrent"


def qbit_ini(port: int, password: str, downloads: Path) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.pbkdf2_hmac("sha512", password.encode(), salt, 100000, 64)
    secret = base64.b64encode(salt).decode() + ":" + base64.b64encode(digest).decode()
    folder = str(downloads).replace("\\", "/").replace('"', '\\"')
    return f"""[Preferences]
WebUI\\Enabled=true
WebUI\\Address=127.0.0.1
WebUI\\Port={port}
WebUI\\Username={QBIT_USER}
WebUI\\Password_PBKDF2="@ByteArray({secret})"
WebUI\\LocalHostAuth=true
WebUI\\AuthSubnetWhitelistEnabled=false
WebUI\\UseUPnP=false
General\\MinimizeToTray=true
Downloads\\SavePath="{folder}"

[BitTorrent]
Session\\DefaultSavePath="{folder}"

[GUI]
StartUpWindowState=Hidden

[LegalNotice]
Accepted=true
"""


def qbit_ready(port: int, password: str) -> bool:
    jar = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    base = f"http://127.0.0.1:{port}"
    try:
        body = urllib.parse.urlencode({"username": QBIT_USER, "password": password}).encode()
        with opener.open(urllib.request.Request(base + "/api/v2/auth/login", data=body, headers={"Referer": base}),
                         timeout=3) as r:
            if r.read().decode().strip().lower().startswith("fails"):
                return False
        with opener.open(urllib.request.Request(base + "/api/v2/app/version", headers={"Referer": base}), timeout=3) as r:
            return r.read().decode().strip().startswith("v")
    except OSError:
        return False


def setup_qbittorrent(st: dict, downloads: Path, report: Report, progress) -> None:
    current = api.request("/api/torrents/settings", timeout=10)
    managed = st.get("qbittorrent") or {}
    if current.get("configured") and not managed:
        report("qbittorrent", "Используется уже подключённый в WEB qBittorrent")
        if not api.request("/api/torrents/settings", timeout=10).get("ready"):
            raise SetupError("Сохранённое в WEB подключение qBittorrent недоступно; проверьте его в разделе «Загрузки»")
        return
    report("qbittorrent", "Проверяем qBittorrent…")
    exe = ensure_component("qbittorrent", progress)
    if not managed:
        s = cfg.load()
        port = next((p for p in range(8090, 8120) if p not in (s.port, s.payload_port) and port_free(p)), 0)
        if not port:
            raise SetupError("Нет свободного локального порта для qBittorrent (8090–8119)")
        managed = {"port": port, "password": secrets.token_urlsafe(24)}
        st["qbittorrent"] = managed
        save_state(st)
    # Linux qBittorrent reads qBittorrent.conf (Windows: qBittorrent.ini). The profile is ours alone;
    # a default file written by an earlier failed start (no PackageFlow login) is replaced.
    conf = qbit_profile() / f"qBittorrent_{QBIT_CONFIGURATION}" / "config" / "qBittorrent.conf"
    downloads.mkdir(parents=True, exist_ok=True)
    current = conf.read_text(encoding="utf-8", errors="replace") if conf.exists() else ""
    if f"WebUI\\Username={QBIT_USER}" not in current or f"WebUI\\Port={managed['port']}" not in current:
        conf.parent.mkdir(parents=True, exist_ok=True)
        conf.write_text(qbit_ini(managed["port"], managed["password"], downloads), encoding="utf-8")
        conf.chmod(0o600)
    argv = [str(exe), f"--profile={qbit_profile()}", f"--configuration={QBIT_CONFIGURATION}", "--confirm-legal-notice"]
    env = {}
    if not qbit_ready(managed["port"], managed["password"]):
        report("qbittorrent", "Запускаем qBittorrent…")
        run_component("qbittorrent", argv, env, exe.parent)
        wait_until(lambda: qbit_ready(managed["port"], managed["password"]), 60, "qBittorrent")
    report("qbittorrent", "Подключаем qBittorrent к WEB…")
    api.request("/api/torrents/settings", "POST", {
        "baseUrl": f"http://127.0.0.1:{managed['port']}", "username": QBIT_USER, "password": managed["password"],
        "downloadPath": str(downloads), "remotePath": str(downloads)}, timeout=30)
    if not api.request("/api/torrents/settings", timeout=10).get("ready"):
        raise SetupError("qBittorrent запущен, но WEB не смог к нему подключиться")
    report("qbittorrent", "qBittorrent готов")


# ---------------------------------------------------------------- FlareSolverr

def flare_ready() -> bool:
    try:
        with urllib.request.urlopen(FLARE_URL, timeout=3) as r:
            return "flaresolverr" in r.read().decode("utf-8", "replace").lower()
    except OSError:
        return False


def ensure_xvfb(report: Report) -> bool:
    """Hidden browser needs Xvfb. Install it like Windows asks for UAC: once, by explicit setup."""
    if shutil.which("Xvfb"):
        return True
    if shutil.which("pkexec") and shutil.which("apt-get"):
        report("flaresolverr", "Устанавливаем xvfb для скрытого браузера (запросит пароль администратора)…")
        r = subprocess.run(["pkexec", "apt-get", "install", "-y", "xvfb"], capture_output=True, text=True)
        if r.returncode == 0 and shutil.which("Xvfb"):
            return True
    report("flaresolverr", "xvfb не установлен — браузер FlareSolverr будет показывать своё окно при проверках")
    return False


def setup_flaresolverr(st: dict, headless: bool, report: Report, progress, restart: bool = False) -> None:
    report("flaresolverr", "Проверяем FlareSolverr…")
    if flare_ready() and not (st.get("flaresolverr") or {}).get("managed"):
        # Another FlareSolverr already answers on 8191 (own install, a container): use it as is.
        st["flaresolverr"] = {"external": True, "headless": True}
        save_state(st)
        if restart:
            raise SetupError("Используется сторонний FlareSolverr: окно браузера для ручного входа откройте в нём самом")
        report("flaresolverr", "Используется уже установленный FlareSolverr — готов")
        return
    exe = ensure_component("flaresolverr", progress)
    chrome = ensure_chrome(report, progress)
    if patch_flaresolverr_chrome(components_dir() / "flaresolverr", chrome) and flare_ready():
        restart = True  # a running FlareSolverr still uses the previous browser
    if headless:
        headless = ensure_xvfb(report)
    st["flaresolverr"] = {"headless": headless, "managed": True}
    save_state(st)
    if flare_ready() and not restart:
        report("flaresolverr", "FlareSolverr готов")
        return
    if not flare_ready() and not port_free(8191):
        raise SetupError("Порт 8191 занят другой программой")
    # LANG as in FlareSolverr's Docker image: it becomes Chrome's --accept-lang, and "en_US.UTF-8"
    # there made RuTracker's Cloudflare check fail every time, while C.UTF-8 passes.
    env = {"HOST": "127.0.0.1", "PORT": "8191", "LOG_LEVEL": "info", "LOG_HTML": "false",
           "LANG": "C.UTF-8", "HEADLESS": "true" if headless else "false"}
    report("flaresolverr", "Запускаем FlareSolverr и Chrome…")
    if restart:
        stop_component("flaresolverr")
        wait_until(lambda: not flare_ready(), 30, "Остановка FlareSolverr")
    run_component("flaresolverr", [str(exe)], env, exe.parent)
    wait_until(flare_ready, 90, "FlareSolverr")
    report("flaresolverr", "FlareSolverr готов")


# ---------------------------------------------------------------- Prowlarr

def prowlarr_data() -> Path:
    return paths.data_home() / "prowlarr"


def bootstrap_prowlarr(st: dict) -> str:
    """Loopback-only instance with our API key; an existing config keeps its key."""
    d = prowlarr_data()
    d.mkdir(parents=True, exist_ok=True)
    path = d / "config.xml"
    if path.exists():
        tree = ET.parse(path)
        root = tree.getroot()
        key = (root.findtext("ApiKey") or "").strip()
        bind = root.find("BindAddress")
        if bind is None:
            bind = ET.SubElement(root, "BindAddress")
        bind.text = "127.0.0.1"
        tree.write(path)
    else:
        key = secrets.token_hex(16)
        root = ET.Element("Config")
        for tag, value in (("BindAddress", "127.0.0.1"), ("Port", "9696"), ("ApiKey", key), ("LaunchBrowser", "False"),
                           ("AuthenticationMethod", "External"), ("AuthenticationRequired", "Enabled"), ("UrlBase", "")):
            ET.SubElement(root, tag).text = value
        ET.ElementTree(root).write(path)
    path.chmod(0o600)
    st["prowlarr"] = {"url": PROWLARR_URL, "key": key}
    save_state(st)
    return key


def prowlarr_ready(key: str) -> bool:
    try:
        Prowlarr(PROWLARR_URL, key, timeout=3).indexers()
        return True
    except (ProwlarrError, OSError, ValueError):
        return False


def existing_prowlarr_key() -> str | None:
    """API key of a Prowlarr already listening on 9696, when its config.xml is readable by this user."""
    for pid in os.listdir("/proc"):
        if not pid.isdigit():
            continue
        try:
            argv = Path(f"/proc/{pid}/cmdline").read_bytes().split(b"\0")
        except OSError:
            continue
        if not argv or not argv[0].decode(errors="replace").endswith("Prowlarr"):
            continue
        data = next((a.decode()[6:] for a in argv if a.startswith(b"-data=")), str(Path.home() / ".config" / "Prowlarr"))
        for root in (Path(data), Path(f"/proc/{pid}/root") / data.lstrip("/")):
            try:
                key = (ET.parse(root / "config.xml").getroot().findtext("ApiKey") or "").strip()
            except (OSError, ET.ParseError):
                continue
            if key and prowlarr_ready(key):
                return key
    return None


def setup_prowlarr(st: dict, report: Report, progress, given_key: str = "") -> Prowlarr:
    report("prowlarr", "Проверяем Prowlarr…")
    key = (st.get("prowlarr") or {}).get("key")
    if key and prowlarr_ready(key):
        report("prowlarr", "Prowlarr готов")
        return Prowlarr(PROWLARR_URL, key)
    if not port_free(9696):
        # Someone's own Prowlarr (another install, a container): connect to it, never replace it.
        key = given_key.strip() if given_key.strip() and prowlarr_ready(given_key.strip()) else existing_prowlarr_key()
        if not key:
            raise ProwlarrKeyRequired("На этом компьютере уже работает Prowlarr (порт 9696). Укажите его API-ключ: "
                                      "Prowlarr → Settings → General → API Key")
        st["prowlarr"] = {"url": PROWLARR_URL, "key": key, "external": True}
        save_state(st)
        report("prowlarr", "Используется уже установленный Prowlarr — готов")
        return Prowlarr(PROWLARR_URL, key)
    exe = ensure_component("prowlarr", progress)
    key = bootstrap_prowlarr(st)
    report("prowlarr", "Запускаем Prowlarr…")
    run_component("prowlarr", [str(exe), "-nobrowser", f"-data={prowlarr_data()}"], {}, exe.parent)
    wait_until(lambda: prowlarr_ready(key), 120, "Prowlarr")
    report("prowlarr", "Prowlarr готов")
    return Prowlarr(PROWLARR_URL, key)


# ---------------------------------------------------------------- RuTracker and WEB

# RuTracker: 1180 = PS4 games, 100546 = PS5 games (WEB shared/search-platforms.ts default).
SEARCH_CATEGORIES = "1180,100546"

CLOUDFLARE_BLOCKED = (
    "RuTracker закрыл страницы входа и поиска проверкой Cloudflare, и FlareSolverr не прошёл её автоматически "
    "(главная страница при этом открывается). Это зависит от сети и IP-адреса: повторите позже или через другую "
    "сеть/VPN. Если у вас уже есть работающий FlareSolverr, запустите его на порту 8191 — мастер подключится к нему.")


def setup_rutracker(st: dict, client: Prowlarr, username: str, password: str, report: Report) -> int:
    # Prowlarr retries a protected page through FlareSolverr several times (60 s each) before answering.
    client = Prowlarr(client.root, client.key, timeout=300)
    report("proxy", "FlareSolverr: проверяем доступ к RuTracker и сохраняем прокси в Prowlarr…")
    tag = client.existing_flaresolverr_tag(FLARE_URL) or client.configure_flaresolverr(FLARE_URL, FLARE_URL)
    if client.used_tracker_fallback:
        report("proxy", "Cloudflare блокирует проверочный сайт Prowlarr; RuTracker открывается — прокси сохранён")
    report("rutracker", "RuTracker: проверяем вход и индексатор…")
    existing = next((i for i, n in client.indexers() if "rutracker" in n.lower()), None)
    try:
        if existing:
            client.attach_rutracker_proxy(existing, tag)
            client.apply_rutracker_credentials(existing, username, password)
            indexer = existing
        else:
            indexer = client.add_rutracker(username, password, tag)
    except ProwlarrError as e:
        if e.captcha:
            raise CaptchaRequired("RuTracker просит код с картинки. Войдите один раз вручную в окне браузера, "
                                  "затем повторите настройку") from None
        if e.unreachable:
            raise SetupError(CLOUDFLARE_BLOCKED) from None
        raise SetupError(f"RuTracker не принят Prowlarr (HTTP {e.status}). Проверьте логин и пароль") from None
    except OSError:  # includes timeouts: Prowlarr kept waiting for FlareSolverr
        raise SetupError(CLOUDFLARE_BLOCKED) from None
    st["tracker"] = {"username": username.strip(), "password": password, "indexer": indexer}
    save_state(st)
    report("rutracker", "RuTracker подключён")
    return indexer


def connect_web_search(client: Prowlarr, indexer: int, report: Report) -> None:
    report("web", "Подключаем поиск к WEB…")
    c = client.connection(indexer)
    api.request("/api/search/settings", "POST",
                {"name": "RuTracker / Torznab", "endpoint": c["endpoint"], "apiKey": c["apiKey"],
                 "categories": SEARCH_CATEGORIES},
                timeout=30)
    report("web", "Проверяем поиск через WEB…")
    api.request("/api/search?q=PS4&offset=0&limit=1", timeout=120)
    report("web", "Поиск подключён. Результаты доступны в PackageFlow")


@dataclass
class Options:
    downloads: Path
    username: str = ""
    password: str = ""
    headless: bool = True
    prowlarr_key: str = ""


def run_setup(o: Options, report: Report, progress: Callable[[str, int], None] | None = None) -> dict:
    if not api.status():
        raise SetupError("Служба PackageFlow не запущена. Запустите её и повторите")
    st = load_state()
    st["downloads"] = str(o.downloads)
    save_state(st)
    prog = (lambda name: (lambda pct: progress(name, pct))) if progress else (lambda name: None)
    setup_qbittorrent(st, o.downloads, report, prog("qbittorrent"))
    setup_flaresolverr(st, o.headless, report, prog("flaresolverr"))
    client = setup_prowlarr(st, report, prog("prowlarr"), o.prowlarr_key)
    if o.username and o.password:
        indexer = setup_rutracker(st, client, o.username, o.password, report)
        connect_web_search(client, indexer, report)
        st["configured"] = True
    else:
        report("rutracker", "RuTracker пропущен — добавьте логин позже через «Настроить поиск»")
        st["configured"] = False
    save_state(st)
    return st


def manual_login(report: Report, timeout: int = 600) -> bool:
    """A visible browser window (FlareSolverr session) for the human to sign in once and pass the captcha.

    Cookies are not copied into Prowlarr; a successful sign-in clears RuTracker's captcha
    requirement for the account, after which the normal setup is retried.
    """
    st = load_state()
    headless = (st.get("flaresolverr") or {}).get("headless", True)
    if headless:
        setup_flaresolverr(st, False, report, None, restart=True)
    session = "packageflow-manual-login-" + secrets.token_hex(8)

    def command(body: dict, wait: int = 80) -> dict:
        req = urllib.request.Request(FLARE_URL + "v1", data=json.dumps(body).encode(), method="POST",
                                     headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=wait) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except (OSError, ValueError):
            return {}

    def page(path: str) -> dict:
        return command({"cmd": "request.get", "session": session, "url": "https://rutracker.org/forum/" + path,
                        "maxTimeout": 60000})

    try:
        if command({"cmd": "sessions.create", "session": session}).get("status") != "ok":
            raise SetupError("Окно браузера для входа недоступно")
        report("rutracker", "Откроется окно браузера с RuTracker: войдите и введите код с картинки")
        page("login.php")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            r = page("index.php")
            sol = r.get("solution") or {}
            url = urllib.parse.urlsplit(str(sol.get("url") or ""))
            if r.get("status") == "ok" and url.scheme == "https" and url.hostname == "rutracker.org" \
                    and url.path.startswith("/forum/") and 'id="logged-in-username"' in (sol.get("response") or ""):
                report("rutracker", "Вход в RuTracker выполнен")
                return True
            time.sleep(5)
        return False
    finally:
        command({"cmd": "sessions.destroy", "session": session}, 15)
        if headless:
            setup_flaresolverr(load_state(), True, report, None, restart=True)


def status() -> dict:
    st = load_state()
    out = {"configured": bool(st.get("configured")), "components": {}}
    for name in ("qbittorrent", "prowlarr", "flaresolverr"):
        if name in st or (name == "qbittorrent" and "qbittorrent" in st):
            out["components"][name] = service.systemctl("is-active", unit_name(name), check=False).stdout.strip() \
                if service.available() else "unknown"
    return out
