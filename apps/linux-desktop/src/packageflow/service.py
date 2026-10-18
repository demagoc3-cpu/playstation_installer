"""systemd user service and login autostart."""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess

from . import api, paths
from . import settings as cfg


class ServiceError(RuntimeError):
    pass


def available() -> bool:
    if os.environ.get("PACKAGEFLOW_NO_SYSTEMD") == "1" or not shutil.which("systemctl"):
        return False
    r = subprocess.run(["systemctl", "--user", "is-system-running"], capture_output=True, text=True)
    return r.stdout.strip() not in ("", "offline")


def systemctl(*args: str, check: bool = True) -> subprocess.CompletedProcess:
    r = subprocess.run(["systemctl", "--user", *args], capture_output=True, text=True, timeout=60)
    if check and r.returncode != 0:
        raise ServiceError((r.stderr or r.stdout).strip() or f"systemctl {' '.join(args)}: код {r.returncode}")
    return r


def quote_exec(argv: list[str]) -> str:
    """systemd ExecStart quoting: double quotes, escape backslash, quote, dollar and percent."""
    def q(a: str) -> str:
        return '"' + a.replace("\\", "\\\\").replace('"', '\\"').replace("$", "$$").replace("%", "%%") + '"'
    return " ".join(q(a) for a in argv)


def unit_text(command: list[str] | None = None) -> str:
    argv = (command or paths.launcher_command()) + ["--server"]
    # An AppImage is mounted at a new /tmp path on every start: no stable file link.
    doc = "" if paths.install_kind() == "appimage" else f"Documentation=file://{paths.install_root()}/README.md\n"
    return f"""[Unit]
Description=PackageFlow WEB server
{doc}After=network-online.target
Wants=network-online.target

[Service]
Type=exec
ExecStart={quote_exec(argv)}
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
KillMode=mixed

[Install]
WantedBy=default.target
"""


def unit_path():
    return paths.user_unit_dir() / paths.UNIT_NAME


def ensure_unit() -> bool:
    """Writes the user unit for this installation. True when it changed."""
    text = unit_text()
    path = unit_path()
    try:
        if path.read_text(encoding="utf-8") == text:
            return False
    except OSError:
        pass
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, path)
    systemctl("daemon-reload")
    return True


def state() -> str:
    """active | inactive | failed | activating | deactivating | not-installed"""
    if not unit_path().exists() and not os.path.exists(f"/usr/lib/systemd/user/{paths.UNIT_NAME}"):
        return "not-installed"
    return systemctl("is-active", paths.UNIT_NAME, check=False).stdout.strip() or "inactive"


def enabled() -> bool:
    return systemctl("is-enabled", paths.UNIT_NAME, check=False).stdout.strip() == "enabled"


def set_enabled(on: bool) -> None:
    systemctl("enable" if on else "disable", paths.UNIT_NAME)


def start() -> None:
    ensure_unit()
    systemctl("start", paths.UNIT_NAME)


def stop(force: bool = False) -> dict | None:
    """Stops only when the WEB reports no active jobs, unless force. Returns prepare-stop reply."""
    reply = None
    if api.status():
        reply = api.prepare_stop()
        if reply.get("busy") is not False and not force:
            raise ServiceError("Есть активные задания или непроверенные операции. Дождитесь их завершения "
                               "или остановите принудительно.")
    systemctl("stop", paths.UNIT_NAME)
    return reply


def restart(force: bool = False) -> None:
    stop(force)
    start()


def journal(lines: int = 200) -> str:
    r = subprocess.run(["journalctl", "--user", "-u", paths.UNIT_NAME, "-n", str(lines), "--no-pager", "-o", "short-iso"],
                       capture_output=True, text=True)
    return r.stdout or r.stderr


def autostart_path():
    return paths.autostart_dir() / "packageflow.desktop"


def set_autostart(on: bool) -> None:
    path = autostart_path()
    if not on:
        path.unlink(missing_ok=True)
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    cmd = " ".join(shlex.quote(a) for a in paths.launcher_command() + ["--tray"])
    path.write_text(f"""[Desktop Entry]
Type=Application
Name=PackageFlow
Comment=PackageFlow в области уведомлений
Exec={cmd}
Icon=packageflow
Terminal=false
X-GNOME-Autostart-enabled=true
NoDisplay=true
""", encoding="utf-8")


def apply_start_at_login(s: cfg.Settings) -> None:
    set_autostart(s.start_at_login)
    if available():
        ensure_unit()
        set_enabled(s.start_at_login)
