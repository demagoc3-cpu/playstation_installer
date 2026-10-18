"""Foreground WEB server process: what the systemd unit runs (`packageflow --server`)."""
from __future__ import annotations

import json
import os
import shutil
import socket
import sys
import time

from . import api, bundle, paths
from . import settings as cfg


def environment(s: cfg.Settings, key: str) -> dict:
    """Same variables the Windows ServerHost passes to node.exe."""
    env = {k: v for k, v in os.environ.items() if not k.startswith(("PACKAGEFLOW_", "NITRO_"))}
    env.update({
        "NODE_ENV": "production",
        "HOST": "0.0.0.0",
        "PORT": str(s.port),
        "PACKAGEFLOW_DATA_DIR": str(s.web_data_dir),
        "PACKAGEFLOW_PAYLOAD_PORT": str(s.payload_port),
        "PACKAGEFLOW_PUBLIC_PORT": str(s.port),
        "PACKAGEFLOW_LAUNCHER_KEY": key,
    })
    if s.host_ip:
        env["PACKAGEFLOW_HOST_IP"] = s.host_ip
    return env


def port_in_use(port: int) -> bool:
    with socket.socket() as sock:
        sock.settimeout(0.5)
        return sock.connect_ex(("127.0.0.1", port)) == 0


RUNTIME_PARTS = ("runtime", "web", "console-setup", "release.json")


def runtime_root() -> "os.PathLike":
    """Where node, WEB and the bundle are read from while the service runs.

    deb: the installation itself. AppImage: a private on-disk copy per build in
    ~/.local/share/PackageFlow/runtime/<version>-<build time>, so the service no
    longer depends on the image's FUSE mount: closing AppImage processes or
    replacing the file during an update cannot pull files from under node (SIGBUS).
    """
    root = paths.install_root()
    if paths.install_kind() != "appimage":
        return root
    rel = paths.release()
    tag = "".join(c for c in f"{rel.get('version', 'x')}-{rel.get('builtAt', 'x')}" if c.isalnum() or c in ".-")
    base = paths.data_home() / "runtime"
    target = base / tag
    if not (target / ".complete").is_file():
        base.mkdir(parents=True, exist_ok=True)
        tmp = base / f".{tag}.{os.getpid()}"
        shutil.rmtree(tmp, ignore_errors=True)
        tmp.mkdir()
        for part in RUNTIME_PARTS:
            src = root / part
            if src.is_dir():
                shutil.copytree(src, tmp / part, symlinks=False)
            else:
                shutil.copy2(src, tmp / part)
        if (tmp / "runtime" / "node").stat().st_size != (root / "runtime" / "node").stat().st_size:
            raise OSError("копия Node.js не совпадает с образом")
        (tmp / ".complete").write_text(tag, encoding="utf-8")
        shutil.rmtree(target, ignore_errors=True)
        os.replace(tmp, target)
        log(f"Файлы службы скопированы из AppImage в {target}")
    for old in base.iterdir():  # the previous build is no longer used once this one starts
        if old != target:
            shutil.rmtree(old, ignore_errors=True)
    return target


def log(message: str) -> None:
    print(f"[packageflow] {message}", file=sys.stderr, flush=True)


def run() -> int:
    s = cfg.load().validate()
    key = cfg.launcher_key()
    for p in (s.port, s.payload_port):
        if port_in_use(p):
            st = api.status(timeout=1.5)
            if st:
                log(f"PackageFlow уже работает на порту {s.port} (pid {st.get('processId')}); второй экземпляр не запускается")
            else:
                log(f"Порт {p} занят другой программой; измените порт в настройках PackageFlow")
            return 75  # EX_TEMPFAIL: systemd retries after RestartSec
    try:
        root = runtime_root()
    except OSError as e:
        log(f"Не удалось подготовить файлы службы: {e}")
        return 1
    node, entry = root / "runtime" / "node", root / "web" / ".output" / "server" / "index.mjs"
    if not node.is_file() or not entry.is_file():
        log(f"Установка повреждена: нет {node if not node.is_file() else entry}")
        return 1
    data = s.web_data_dir
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        m = bundle.stage(root / "console-setup", data)
    except bundle.BundleError as e:
        log(f"Комплект для приставок не принят: {e}")
        return 1
    if m:
        log(f"Комплект приставок: PS5 ELF {m['elf']['version']} ({m['elf']['buildId']}), PS5 app {m['app']['version']}"
            + (f", PS4 {m['ps4']['version']}" if 'ps4' in m else ""))
    state = paths.state_dir()
    state.mkdir(parents=True, exist_ok=True)
    (state / "server.json").write_text(json.dumps({
        "pid": os.getpid(), "version": paths.release().get("version"), "root": str(root),
        "kind": paths.install_kind(), "port": s.port, "startedAt": int(time.time()),
    }), encoding="utf-8")
    log(f"WEB {paths.release().get('version')} на порту {s.port}, данные {data}")
    os.chdir(entry.parent.parent)
    os.execve(str(node), [str(node), str(entry)], environment(s, key))
    return 0  # not reached
