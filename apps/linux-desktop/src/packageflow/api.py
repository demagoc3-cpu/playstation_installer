"""Launcher-only WEB endpoints (/api/desktop/*), authenticated by the launcher key."""
from __future__ import annotations

import http.client
import json

from . import settings as cfg


class ApiError(OSError):
    pass


def request(path: str, method: str = "GET", body: dict | None = None, timeout: float = 3.0,
            port: int | None = None, key: str | None = None) -> dict:
    s = cfg.load()
    conn = http.client.HTTPConnection("127.0.0.1", port or s.port, timeout=timeout)
    try:
        data = json.dumps(body).encode() if body is not None else None
        headers = {"X-PackageFlow-Launcher-Key": key or cfg.launcher_key(), "Connection": "close"}
        if data is not None:
            headers["Content-Type"] = "application/json"
        conn.request(method, path, body=data, headers=headers)
        r = conn.getresponse()
        raw = r.read()
        if r.status != 200:
            raise ApiError(f"WEB ответил HTTP {r.status} на {path}")
        return json.loads(raw.decode("utf-8") or "{}")
    except (OSError, http.client.HTTPException, ValueError) as e:
        if isinstance(e, ApiError):
            raise
        raise ApiError(str(e)) from e
    finally:
        conn.close()


def status(timeout: float = 2.0) -> dict | None:
    """The WEB's own status, or None when nothing (ours) answers."""
    try:
        s = request("/api/desktop/status", timeout=timeout)
    except ApiError:
        return None
    return s if s.get("application") == "PackageFlow" else None


def prepare_stop() -> dict:
    """Drains new requests; {'busy': true, ...} means active jobs would be interrupted."""
    return request("/api/desktop/prepare-stop", "POST", {}, timeout=10.0)
