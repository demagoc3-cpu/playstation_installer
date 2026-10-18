"""Where the installation and the per-user files live."""
from __future__ import annotations

import json
import os
from pathlib import Path

APP_NAME = "PackageFlow"
UNIT_NAME = "packageflow.service"


def install_root() -> Path:
    """<root>/app/packageflow/paths.py -> <root>; PACKAGEFLOW_ROOT overrides (tests, AppRun)."""
    env = os.environ.get("PACKAGEFLOW_ROOT")
    return Path(env).resolve() if env else Path(__file__).resolve().parents[2]


def install_kind() -> str:
    """deb | appimage | dev — decides what the systemd unit starts."""
    if os.environ.get("APPIMAGE"):
        return "appimage"
    if install_root() == Path("/usr/lib/packageflow"):
        return "deb"
    return "dev"


def launcher_command() -> list[str]:
    """The command systemd and autostart use to start this installation."""
    kind = install_kind()
    if kind == "appimage":
        return [os.environ["APPIMAGE"]]
    return [str(install_root() / "bin" / "packageflow")]


def release() -> dict:
    try:
        return json.loads((install_root() / "release.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"version": "dev"}


def _xdg(name: str, fallback: str) -> Path:
    value = os.environ.get(name)
    return Path(value) if value and os.path.isabs(value) else Path.home() / fallback


def config_dir() -> Path:
    return _xdg("XDG_CONFIG_HOME", ".config") / APP_NAME


def data_home() -> Path:
    return _xdg("XDG_DATA_HOME", ".local/share") / APP_NAME


def state_dir() -> Path:
    return _xdg("XDG_STATE_HOME", ".local/state") / APP_NAME


def user_unit_dir() -> Path:
    return _xdg("XDG_CONFIG_HOME", ".config") / "systemd" / "user"


def autostart_dir() -> Path:
    return _xdg("XDG_CONFIG_HOME", ".config") / "autostart"


def node_binary() -> Path:
    return install_root() / "runtime" / "node"


def web_entry() -> Path:
    return install_root() / "web" / ".output" / "server" / "index.mjs"


def console_bundle() -> Path:
    return install_root() / "console-setup"


def icon_theme_dir() -> Path:
    return install_root() / "icons"
