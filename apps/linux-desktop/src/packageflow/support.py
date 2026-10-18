"""«Поддержать проект»: the same donation wallets as the Windows app (Assets/donations.json)."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from . import paths


@dataclass(frozen=True)
class Wallet:
    name: str
    network: str
    address: str
    qr: tuple


TEXT = ("PackageFlow — бесплатный проект с открытым кодом. "
        "Ваша поддержка помогает развивать приложение и исправлять ошибки.")


def load() -> list[Wallet]:
    """Wallets bundled from the pinned WEB commit; malformed entries are skipped, never guessed."""
    try:
        raw = json.loads((paths.install_root() / "assets" / "donations.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    out = []
    for w in raw if isinstance(raw, list) else []:
        try:
            name, network, address, qr = w["Name"], w["Network"], w["Address"], w["Qr"]
        except (KeyError, TypeError):
            continue
        if not (isinstance(address, str) and re.fullmatch(r"[A-Za-z0-9]{20,128}", address)):
            continue
        if not (isinstance(qr, list) and qr and all(isinstance(r, list) and len(r) == len(qr) for r in qr)):
            continue
        out.append(Wallet(str(name), str(network), address, tuple(tuple(bool(c) for c in r) for r in qr)))
    return out
