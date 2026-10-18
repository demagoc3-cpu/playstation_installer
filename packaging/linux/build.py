#!/usr/bin/env python3
"""Builds dist/linux/packageflow_<ver>-<rev>_amd64.deb and dist/linux/PackageFlow-<ver>-x86_64.AppImage.

Same layout as packaging/windows: the WEB is built from this repository
(npm ci + npm run build -> .output), the desktop shell comes from
apps/linux-desktop, the console bundle (PF_PS5_BUNDLE or --bundle) must match
packaging/windows/console-bundle-<version>.json, Node.js linux-x64 is checked
against nodejs.org SHASUMS256 and the AppImage runtime is pinned by SHA-256.

    python3 packaging/linux/build.py --version 1.10.28 [--bundle DIR] [deb] [appimage]
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import time
import urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
PKG = REPO / "packaging" / "linux"
APP = REPO / "apps" / "linux-desktop"
sys.path.insert(0, str(APP / "src"))
from packageflow import bundle  # noqa: E402

PINS = PKG / "pins.json"
TOOLS = REPO / ".toolchains" / "linux"
STAGE = REPO / "dist" / "linux" / "stage"
DIST = REPO / "dist" / "linux"


def sha256(path: Path) -> str:
    return bundle.sha256(path)


def fetch(url: str, dest: Path) -> Path:
    if not dest.exists():
        dest.parent.mkdir(parents=True, exist_ok=True)
        print(f"Загрузка {url}")
        tmp = dest.with_suffix(dest.suffix + ".part")
        with urllib.request.urlopen(url, timeout=120) as r, tmp.open("wb") as f:
            shutil.copyfileobj(r, f)
        tmp.replace(dest)
    return dest


def node_runtime(pins: dict) -> Path:
    version, archive = pins["node"]["version"], pins["node"]["archive"]
    base = f"https://nodejs.org/dist/v{version}"
    folder = TOOLS / f"node-{version}"
    sums = fetch(f"{base}/SHASUMS256.txt", folder / "SHASUMS256.txt").read_text()
    expected = next((l.split()[0] for l in sums.splitlines() if l.endswith("  " + archive)), None)
    if not expected:
        raise SystemExit(f"В SHASUMS256 Node.js нет {archive}")
    tar = fetch(f"{base}/{archive}", folder / archive)
    if sha256(tar) != expected:
        tar.unlink()
        raise SystemExit("Контрольная сумма Node.js не совпала; файл удалён, повторите сборку")
    out = folder / "extracted"
    if not (out / "node").exists():
        out.mkdir(parents=True, exist_ok=True)
        prefix = archive.removesuffix(".tar.xz")
        with tarfile.open(tar) as t:
            for name, target in ((f"{prefix}/bin/node", "node"), (f"{prefix}/LICENSE", "LICENSE")):
                src = t.extractfile(name)
                (out / target).write_bytes(src.read())
        (out / "node").chmod(0o755)
    return out


def appimage_runtime(pins: dict) -> Path:
    rt = pins["appimageRuntime"]
    path = fetch(rt["url"], TOOLS / "appimage" / "runtime-x86_64")
    digest = sha256(path)
    if rt.get("sha256") is None:
        rt["sha256"] = digest
        PINS.write_text(json.dumps(pins, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"Среда AppImage закреплена: {digest}")
    elif rt["sha256"] != digest:
        raise SystemExit(f"Среда AppImage отличается от закреплённой ({digest}); проверьте и обновите pins.json вручную")
    return path


def icons(dest: Path) -> None:
    import gi
    gi.require_version("GdkPixbuf", "2.0")
    from gi.repository import GdkPixbuf
    svg = REPO / "public" / "favicon.svg"
    scalable = dest / "hicolor" / "scalable" / "apps"
    scalable.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(svg, scalable / "packageflow.svg")
    for size in (48, 128, 256):
        d = dest / "hicolor" / f"{size}x{size}" / "apps"
        d.mkdir(parents=True, exist_ok=True)
        GdkPixbuf.Pixbuf.new_from_file_at_size(str(svg), size, size).savev(str(d / "packageflow.png"), "png", [], [])


def copytree(src: Path, dst: Path) -> None:
    shutil.copytree(src, dst, symlinks=False, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))


def stage_root(pins: dict, node: Path, prefix: Path) -> dict:
    """<prefix> becomes /usr/lib/packageflow (deb) or AppDir/usr/lib/packageflow (AppImage)."""
    web = REPO / ".output"
    if not (web / "server" / "index.mjs").is_file():
        raise SystemExit("Нет собранного WEB (.output); запустите сборку без --skip-web-build")
    if any(web.rglob("*.node")):
        raise SystemExit("В WEB есть нативные модули Node")
    src_bundle = Path(pins["consoleBundle"]["path"])
    m = bundle.verify(src_bundle)
    if m is None:
        raise SystemExit("Комплект для приставок не найден")
    manifest_digest = sha256(src_bundle / "manifest.json")
    pinned = REPO / "packaging" / "windows" / f"console-bundle-{pins['version']}.json"
    if pinned.is_file() and json.loads(pinned.read_text(encoding="utf-8")) != json.loads(
            (src_bundle / "manifest.json").read_text(encoding="utf-8")):
        raise SystemExit(f"Комплект не совпадает с {pinned.name}")
    if prefix.exists():
        shutil.rmtree(prefix)
    (prefix / "bin").mkdir(parents=True)
    copytree(APP / "src", prefix / "app")
    shutil.copyfile(PKG / "bin-packageflow.sh", prefix / "bin" / "packageflow")
    (prefix / "bin" / "packageflow").chmod(0o755)
    (prefix / "runtime").mkdir()
    for f in ("node", "LICENSE"):
        shutil.copy2(node / f, prefix / "runtime" / f)
    copytree(web, prefix / "web" / ".output")
    (prefix / "console-setup").mkdir()
    for role in ("elf", "app", "ps4"):
        if role in m:
            shutil.copyfile(src_bundle / m[role]["fileName"], prefix / "console-setup" / m[role]["fileName"])
    shutil.copyfile(src_bundle / "manifest.json", prefix / "console-setup" / "manifest.json")
    if bundle.verify(prefix / "console-setup") != m:
        raise SystemExit("Копия комплекта не прошла проверку")
    icons(prefix / "icons")
    donations = REPO / "apps" / "windows-launcher" / "PackageFlow.Windows" / "Assets" / "donations.json"
    (prefix / "assets").mkdir()
    shutil.copyfile(donations, prefix / "assets" / "donations.json")
    shutil.copyfile(APP / "README.md", prefix / "README.md")
    shutil.copyfile(REPO / "LICENSE", prefix / "LICENSE")
    release = {
        "application": "PackageFlow", "version": pins["version"], "debRevision": int(pins["debRevision"]),
        "platform": "linux-x64",
        "webCommit": pins["web"]["commit"], "node": pins["node"]["version"],
        "console": {"elf": f"{m['elf']['version']} {m['elf']['buildId']}", "app": f"{m['app']['version']} {m['app']['buildId']}",
                    "ps4": m.get("ps4", {}).get("version"), "manifestSha256": manifest_digest},
        "builtAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    (prefix / "release.json").write_text(json.dumps(release, ensure_ascii=False, indent=2), encoding="utf-8")
    return release


def du_kib(path: Path) -> int:
    return sum(p.stat().st_size for p in path.rglob("*") if p.is_file() and not p.is_symlink()) // 1024 + 1


def build_deb(pins: dict, node: Path) -> Path:
    tree = STAGE / "deb"
    if tree.exists():
        shutil.rmtree(tree)
    prefix = tree / "usr" / "lib" / "packageflow"
    release = stage_root(pins, node, prefix)
    (tree / "usr" / "bin").mkdir(parents=True)
    os.symlink("../lib/packageflow/bin/packageflow", tree / "usr" / "bin" / "packageflow")
    apps = tree / "usr" / "share" / "applications"
    apps.mkdir(parents=True)
    shutil.copyfile(PKG / "io.packageflow.PackageFlow.desktop", apps / "io.packageflow.PackageFlow.desktop")
    shutil.copytree(prefix / "icons" / "hicolor", tree / "usr" / "share" / "icons" / "hicolor")
    units = tree / "usr" / "lib" / "systemd" / "user"
    units.mkdir(parents=True)
    from packageflow import service
    os.environ["PACKAGEFLOW_ROOT"] = "/usr/lib/packageflow"
    (units / "packageflow.service").write_text(service.unit_text(["/usr/lib/packageflow/bin/packageflow"]), encoding="utf-8")
    del os.environ["PACKAGEFLOW_ROOT"]
    doc = tree / "usr" / "share" / "doc" / "packageflow"
    doc.mkdir(parents=True)
    shutil.copyfile(prefix / "LICENSE", doc / "copyright")
    debian = tree / "DEBIAN"
    debian.mkdir()
    control = (PKG / "deb" / "control.in").read_text(encoding="utf-8")
    for k, v in {"VERSION": pins["version"], "REVISION": pins["debRevision"], "SIZE": str(du_kib(tree)),
                 "ELF": release["console"]["elf"], "APP": release["console"]["app"],
                 "PS4": str(release["console"]["ps4"]), "NODE": pins["node"]["version"]}.items():
        control = control.replace(f"@{k}@", v)
    (debian / "control").write_text(control, encoding="utf-8")
    for script in ("postinst", "postrm"):
        shutil.copyfile(PKG / "deb" / script, debian / script)
        (debian / script).chmod(0o755)
    tree.chmod(0o755)
    for p in tree.rglob("*"):
        if p.is_dir():
            p.chmod(0o755)
        elif p.is_file() and not p.is_symlink():
            p.chmod(0o755 if os.access(p, os.X_OK) or p.parent.name in ("bin", "DEBIAN") or p.name == "node" else 0o644)
    for script in ("postinst", "postrm"):
        (debian / script).chmod(0o755)
    DIST.mkdir(exist_ok=True)
    out = DIST / f"packageflow_{pins['version']}-{pins['debRevision']}_amd64.deb"
    subprocess.run(["dpkg-deb", "--root-owner-group", "-Zxz", "--build", str(tree), str(out)], check=True)
    return out


def build_appimage(pins: dict, node: Path) -> Path:
    runtime = appimage_runtime(pins)
    appdir = STAGE / "PackageFlow.AppDir"
    if appdir.exists():
        shutil.rmtree(appdir)
    prefix = appdir / "usr" / "lib" / "packageflow"
    stage_root(pins, node, prefix)
    shutil.copyfile(PKG / "appimage" / "AppRun", appdir / "AppRun")
    (appdir / "AppRun").chmod(0o755)
    shutil.copyfile(PKG / "io.packageflow.PackageFlow.desktop", appdir / "io.packageflow.PackageFlow.desktop")
    shutil.copyfile(prefix / "icons" / "hicolor" / "256x256" / "apps" / "packageflow.png", appdir / "packageflow.png")
    os.symlink("packageflow.png", appdir / ".DirIcon")
    share = appdir / "usr" / "share"
    (share / "applications").mkdir(parents=True)
    shutil.copyfile(appdir / "io.packageflow.PackageFlow.desktop", share / "applications" / "io.packageflow.PackageFlow.desktop")
    shutil.copytree(prefix / "icons" / "hicolor", share / "icons" / "hicolor")
    squash = STAGE / "PackageFlow.squashfs"
    squash.unlink(missing_ok=True)
    subprocess.run(["mksquashfs", str(appdir), str(squash), "-root-owned", "-noappend", "-comp", "zstd",
                    "-quiet", "-no-progress"], check=True)
    DIST.mkdir(exist_ok=True)
    out = DIST / f"PackageFlow-{pins['version']}-x86_64.AppImage"
    # A running AppImage (its own service) keeps the old inode: write aside, then rename.
    tmp = out.with_name(out.name + ".tmp")
    with tmp.open("wb") as f:
        f.write(runtime.read_bytes())
        f.write(squash.read_bytes())
    tmp.chmod(0o755)
    os.replace(tmp, out)
    squash.unlink()
    return out


def web_commit() -> str:
    head = subprocess.run(["git", "-C", str(REPO), "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(REPO), "status", "--porcelain", "--untracked-files=no"],
                           capture_output=True, text=True).stdout.strip()
    return head + ("-dirty" if dirty else "")


def npm() -> list[str]:
    if os.environ.get("PF_NPM_CLI"):
        return ["node", os.environ["PF_NPM_CLI"]]
    if shutil.which("npm"):
        return ["npm"]
    for c in sorted(Path.home().glob(".local/share/pnpm/store/v*/links/@/npm/*/*/node_modules/npm/bin/npm-cli.js")):
        return ["node", str(c)]
    raise SystemExit("Не найден npm; задайте PF_NPM_CLI=/путь/npm-cli.js")


def build_web() -> None:
    out = subprocess.run(["node", "-p", "process.versions.node.split('.')[0]"], capture_output=True, text=True)
    if out.stdout.strip() != "22":
        raise SystemExit("Для сборки WEB нужен Node.js 22")
    subprocess.run([*npm(), "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=REPO, check=True)
    subprocess.run([*npm(), "run", "build"], cwd=REPO, check=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("targets", nargs="*", choices=["deb", "appimage"], default=["deb", "appimage"])
    ap.add_argument("--version", required=True, help="версия как у Windows, например 1.10.28")
    ap.add_argument("--deb-revision", default="1")
    ap.add_argument("--bundle", default=os.environ.get("PF_PS5_BUNDLE", ""),
                    help="проверенный комплект для приставок (manifest.json и файлы)")
    ap.add_argument("--skip-web-build", action="store_true")
    a = ap.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", a.version) or a.version.startswith("10."):
        raise SystemExit("Версия должна быть вида 1.x.y, например 1.10.28")
    if not a.bundle:
        raise SystemExit("Укажите комплект для приставок: --bundle DIR или PF_PS5_BUNDLE")
    pins = json.loads(PINS.read_text(encoding="utf-8"))
    pins.update(version=a.version, debRevision=a.deb_revision,
                consoleBundle={"path": a.bundle}, web={"commit": web_commit()})
    if not a.skip_web_build:
        build_web()
    node = node_runtime(pins)
    outputs = []
    if "deb" in a.targets:
        outputs.append(build_deb(pins, node))
    if "appimage" in a.targets:
        outputs.append(build_appimage(pins, node))
    lines = [f"{sha256(p)}  {p.name}" for p in outputs]
    (DIST / "SHA256SUMS").write_text("\n".join(lines) + "\n", encoding="utf-8")
    for p, line in zip(outputs, lines):
        print(f"{p}  ({p.stat().st_size / 1e6:.1f} МБ)\n  {line.split()[0]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
