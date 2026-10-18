"""User settings (same meaning and limits as the Windows LauncherSettings)."""
from __future__ import annotations

import ipaddress
import json
import os
import secrets
from dataclasses import asdict, dataclass, fields
from pathlib import Path

from . import paths


class SettingsError(ValueError):
    pass


@dataclass
class Settings:
    port: int = 3000
    payload_port: int = 3001
    host_ip: str = ""
    data_dir: str = ""
    start_at_login: bool = True
    first_run_done: bool = False

    @property
    def web_data_dir(self) -> Path:
        return Path(self.data_dir) if self.data_dir else paths.data_home() / "web"

    def validate(self) -> "Settings":
        for name in ("port", "payload_port"):
            value = getattr(self, name)
            if not isinstance(value, int) or not 1024 <= value <= 65535:
                raise SettingsError("Порты WEB должны быть в диапазоне 1024–65535")
        if self.port == self.payload_port:
            raise SettingsError("Порт WEB и порт передачи должны различаться")
        if self.host_ip:
            try:
                ip = ipaddress.IPv4Address(self.host_ip)
            except ValueError:
                raise SettingsError("IP-адрес компьютера должен быть IPv4") from None
            if ip.is_loopback or ip.is_unspecified:
                raise SettingsError("Укажите адрес компьютера в локальной сети, а не 127.0.0.1 или 0.0.0.0")
        if self.data_dir and not os.path.isabs(self.data_dir):
            raise SettingsError("Каталог данных WEB должен быть абсолютным путём")
        return self


def settings_path() -> Path:
    return paths.config_dir() / "settings.json"


def load() -> Settings:
    try:
        raw = json.loads(settings_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return Settings()
    known = {f.name for f in fields(Settings)}
    return Settings(**{k: v for k, v in raw.items() if k in known})


def save(s: Settings) -> None:
    s.validate()
    _atomic_write(settings_path(), json.dumps(asdict(s), ensure_ascii=False, indent=2), 0o600)


def launcher_key() -> str:
    """Per-user secret shared with the WEB (/api/desktop/*). Readable only by the user."""
    path = paths.config_dir() / "launcher.key"
    try:
        key = path.read_text(encoding="ascii").strip()
        if len(key) == 64:
            return key
    except OSError:
        pass
    key = secrets.token_hex(32)
    _atomic_write(path, key + "\n", 0o600)
    return key


def _atomic_write(path: Path, text: str, mode: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    tmp = path.with_name(path.name + ".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)
