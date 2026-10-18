"""Stages the verified console bundle into the WEB data directory.

Same rules as the Windows ConsoleArtifacts.Stage: strict names, sizes and
SHA-256 from manifest.json, atomic copies, plus the running-ELF candidate in
ps5-service-updates/. A missing bundle is allowed (PS4-only use).
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
from pathlib import Path

LIMITS = {"elf": 4 * 1024 * 1024, "ps4": 25 * 1024 * 1024, "app": 256 * 1024 * 1024}
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


class BundleError(ValueError):
    pass


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify(bundle: Path) -> dict | None:
    manifest = bundle / "manifest.json"
    if not manifest.is_file():
        return None
    try:
        m = json.loads(manifest.read_text(encoding="utf-8"))
    except ValueError:
        raise BundleError("manifest.json комплекта приставок повреждён") from None
    if m.get("schemaVersion") != 1:
        raise BundleError("Неподдерживаемая версия комплекта приставок")
    elf = m.get("elf") or {}
    if elf.get("firmware") != "13.60" or not re.match(r"^\d+\.\d+\.\d+(?:-dev)?$", str(elf.get("version", ""))) \
            or not re.match(r"^[a-z0-9-]{1,64}$", str(elf.get("buildId", ""))):
        raise BundleError("Неверная версия ELF в комплекте")
    for role in (("elf", "app", "ps4") if "ps4" in m else ("elf", "app")):
        e = m.get(role) or {}
        name, size, digest = e.get("fileName", ""), e.get("size", 0), e.get("sha256", "")
        if not NAME.match(name) or ".." in name or not re.match(r"^[a-f0-9]{64}$", digest) \
                or not isinstance(size, int) or not 0 < size <= LIMITS[role]:
            raise BundleError(f"Неверное описание файла {role} в комплекте")
        src = bundle / name
        if src.is_symlink() or not src.is_file() or src.stat().st_size != size:
            raise BundleError(f"Файл {name} отсутствует или изменился")
        if sha256(src) != digest:
            raise BundleError(f"Контрольная сумма {name} не совпадает")
    return m


def _copy(src: Path, dst: Path, digest: str) -> None:
    if dst.is_file() and not dst.is_symlink() and dst.stat().st_size == src.stat().st_size and sha256(dst) == digest:
        return
    tmp = dst.with_name(dst.name + ".tmp")
    shutil.copyfile(src, tmp)
    os.replace(tmp, dst)


def _write(path: Path, text: str) -> None:
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)


def stage(bundle: Path, data_dir: Path) -> dict | None:
    m = verify(bundle)
    if m is None:
        return None
    dest = data_dir / "console-setup"
    dest.mkdir(parents=True, exist_ok=True)
    for role in ("elf", "app", "ps4"):
        if role in m:
            _copy(bundle / m[role]["fileName"], dest / m[role]["fileName"], m[role]["sha256"])
    _write(dest / "manifest.json", json.dumps(m, separators=(",", ":")))
    elf = m["elf"]
    updates = data_dir / "ps5-service-updates"
    updates.mkdir(parents=True, exist_ok=True)
    _copy(bundle / elf["fileName"], updates / "PackageFlowService-PS5.elf", elf["sha256"])
    _write(updates / "release.json", json.dumps({
        "service": "PackageFlowService-PS5", "fileName": "PackageFlowService-PS5.elf",
        "version": elf["version"], "buildId": elf["buildId"], "sha256": elf["sha256"], "firmware": elf["firmware"],
    }, separators=(",", ":")))
    return m
