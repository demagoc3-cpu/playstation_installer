"""Application updates from GitHub Releases, with the same rules as the Windows ReleaseDownloads.

- Only stable releases (no drafts or prereleases) of the PackageFlow repository.
- The asset must carry GitHub's own SHA-256 digest, a size, and a download URL
  inside this repository's releases; the download is checked against both.
- The asset type matches this installation: .deb for the package, .AppImage for the image.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from . import paths

REPOSITORY = "demagoc3-cpu/playstation_installer"
API = f"https://api.github.com/repos/{REPOSITORY}/releases?per_page=100"
DOWNLOAD_PREFIX = f"https://github.com/{REPOSITORY}/releases/download/"
PATTERNS = {
    "deb": re.compile(r"^packageflow_(\d+)\.(\d+)\.(\d+)-(\d+)_amd64\.deb$"),
    "appimage": re.compile(r"^PackageFlow-(\d+)\.(\d+)\.(\d+)-x86_64\.AppImage$"),
}
MAX_SIZE = 1_000_000_000


class UpdateError(RuntimeError):
    pass


@dataclass(frozen=True)
class Asset:
    kind: str
    version: str
    key: tuple
    name: str
    url: str
    size: int
    sha256: str


def version_key(version: str, revision: int = 0) -> tuple:
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)", version or "")
    return (int(m[1]), int(m[2]), int(m[3]), revision) if m else (0, 0, 0, 0)


def installed_key() -> tuple:
    r = paths.release()
    return version_key(r.get("version", ""), int(r.get("debRevision", 0) or 0))


def _verified(kind: str, asset: dict, match: re.Match) -> Asset | None:
    name, url = asset.get("name", ""), asset.get("browser_download_url", "")
    digest, size = asset.get("digest") or "", asset.get("size") or 0
    if name != os.path.basename(name) or not url.startswith(DOWNLOAD_PREFIX) or not url.endswith("/" + name):
        return None
    if not re.match(r"^sha256:[0-9a-fA-F]{64}$", digest) or not isinstance(size, int) or not 0 < size <= MAX_SIZE:
        return None
    nums = [int(x) for x in match.groups()]
    revision = nums[3] if kind == "deb" else 0
    version = ".".join(str(n) for n in nums[:3])
    if nums[0] == 10:  # the mistaken 10.x.x line is never offered (as in Windows)
        return None
    return Asset(kind, version, (*nums[:3], revision), name, url, size, digest[7:].lower())


def select_latest(kind: str, releases: list) -> Asset | None:
    best = None
    for rel in releases:
        if not isinstance(rel, dict) or rel.get("draft") or rel.get("prerelease"):
            continue
        for asset in rel.get("assets") or []:
            m = PATTERNS[kind].match(asset.get("name", ""))
            a = _verified(kind, asset, m) if m else None
            if a and (best is None or a.key > best.key):
                best = a
    return best


def fetch_releases(timeout: float = 15.0) -> list:
    req = urllib.request.Request(API, headers={"User-Agent": "PackageFlow-Linux/1", "Accept": "application/vnd.github+json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = json.loads(r.read().decode("utf-8"))
    except (OSError, ValueError) as e:
        raise UpdateError(f"Не удалось проверить обновления: {e}") from e
    if not isinstance(data, list):
        raise UpdateError("GitHub вернул неожиданный ответ")
    return data


def check() -> dict:
    """{'kind', 'installed', 'available': Asset|None, 'newer': bool, 'message'}"""
    kind = paths.install_kind()
    installed = paths.release().get("version", "dev")
    if kind not in PATTERNS:
        return {"kind": kind, "installed": installed, "available": None, "newer": False,
                "message": "Сборка разработчика не обновляется автоматически"}
    asset = select_latest(kind, fetch_releases())
    if asset is None:
        return {"kind": kind, "installed": installed, "available": None, "newer": False,
                "message": "Linux-сборка ещё не опубликована в GitHub Releases"}
    newer = asset.key > installed_key()
    return {"kind": kind, "installed": installed, "available": asset, "newer": newer,
            "message": f"Доступна версия {asset.version}" if newer else "Установлена актуальная версия"}


def download(asset: Asset, dest: Path, progress: Callable[[int], None] | None = None) -> Path:
    """Streams to dest.part, checks size and SHA-256, then renames. A mismatch leaves nothing behind."""
    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    h, total, last = hashlib.sha256(), 0, -1
    req = urllib.request.Request(asset.url, headers={"User-Agent": "PackageFlow-Linux/1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r, part.open("wb") as f:
            while block := r.read(1 << 20):
                total += len(block)
                if total > asset.size:
                    raise UpdateError("Загрузка больше, чем файл выпуска")
                h.update(block)
                f.write(block)
                pct = total * 100 // asset.size
                if progress and pct != last:
                    last = pct
                    progress(pct)
        if total != asset.size or h.hexdigest() != asset.sha256:
            raise UpdateError("Размер или SHA-256 загруженного обновления не совпадает с выпуском")
    except BaseException:
        part.unlink(missing_ok=True)
        raise
    os.replace(part, dest)
    return dest


def download_path(asset: Asset) -> Path:
    if asset.kind == "appimage":
        # Same directory as the running image, so the final replace is an atomic rename.
        return Path(os.environ["APPIMAGE"]).with_name("." + asset.name + ".update")
    return paths.state_dir() / "updates" / asset.name


def install(asset: Asset, file: Path) -> list[str]:
    """Applies a downloaded, verified update. Returns the command that starts the new version."""
    if asset.kind == "appimage":
        target = Path(os.environ["APPIMAGE"])
        file.chmod(0o755)
        os.replace(file, target)  # the running process keeps the old inode
        return [str(target)]
    if shutil.which("pkexec") and shutil.which("apt-get"):
        r = subprocess.run(["pkexec", "apt-get", "install", "-y", str(file)], capture_output=True, text=True)
        if r.returncode == 0:
            return ["/usr/bin/packageflow"]
        if r.returncode in (126, 127):
            raise UpdateError("Установка отменена: пароль администратора не введён")
        raise UpdateError((r.stderr or r.stdout).strip()[-800:] or f"apt-get: код {r.returncode}")
    subprocess.Popen(["xdg-open", str(file)])
    raise UpdateError(f"Пакет загружен и открыт в установщике системы: {file}. После установки перезапустите службу.")
