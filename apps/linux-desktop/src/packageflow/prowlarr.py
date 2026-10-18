"""Prowlarr API client: a line-by-line port of the Windows PackageFlow.Core.ProwlarrClient."""
from __future__ import annotations

import copy
import json
import urllib.error
import urllib.parse
import urllib.request

TAG = "packageflow-rutracker"
PROXY_NAME = "PackageFlow FlareSolverr"
CAPTCHA_TEXT = "Введите код подтверждения"
CHALLENGE_MARKERS = ("_cf_chl_opt", "/cdn-cgi/challenge-platform/", "challenges.cloudflare.com",
                     "cf-turnstile-response", "<title>Just a moment", "<title>Один момент")


UNREACHABLE_TEXT = "unable to connect to indexer"


class ProwlarrError(RuntimeError):
    def __init__(self, status: int, path: str, captcha: bool = False, unreachable: bool = False):
        super().__init__(f"Prowlarr ({status}). Проверьте соответствующий тест и журнал Prowlarr.")
        self.status, self.path, self.captcha, self.unreachable = status, path, captcha, unreachable


def validate_address(address: str) -> str:
    u = urllib.parse.urlsplit(address.rstrip("/") + "/")
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError("Укажите HTTP(S)-адрес Prowlarr без логина и параметров")
    return urllib.parse.urlunsplit(u)


def is_rutracker(node: dict) -> bool:
    return any("rutracker" in str(node.get(k) or "").lower() for k in ("definitionName", "implementationName", "name"))


def templates(node):
    if node:
        yield node
        for preset in node.get("presets") or []:
            if preset:
                yield preset


def add_tag(item: dict, tag: int) -> None:
    tags = item.setdefault("tags", [])
    if tag not in tags:
        tags.append(tag)


def _field(fields: list, *names: str) -> dict | None:
    return next((f for f in fields if f.get("name") in names), None)


def prepare_rutracker(template: dict, username: str, password: str, profile: int) -> dict:
    c = copy.deepcopy(template)
    c.pop("id", None)
    c.pop("presets", None)
    c.update(name="RuTracker.org", enable=True, appProfileId=profile, priority=25)
    fields = c.get("fields")
    if not isinstance(fields, list):
        raise RuntimeError("В описании индексатора нет полей")
    user, pw = _field(fields, "username", "userName"), _field(fields, "password")
    if not user or not pw:
        raise RuntimeError("Это описание RuTracker требует ручной авторизации в Prowlarr")
    user["value"], pw["value"] = username.strip(), password
    return c


def is_tracker_page(solution: dict) -> bool:
    """FlareSolverr reports status 200 even for an unsolved challenge: inspect the page itself."""
    html = solution.get("response") or ""
    if not html.strip():
        return False
    low = html.lower()
    return not any(m.lower() in low for m in CHALLENGE_MARKERS) and bool(solution.get("cookies"))


class Prowlarr:
    def __init__(self, address: str, api_key: str, timeout: float = 90.0):
        self.root, self.key, self.timeout = validate_address(address), api_key, timeout
        self.used_tracker_fallback = False

    def request(self, path: str, method: str = "GET", body=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(urllib.parse.urljoin(self.root, path), data=data, method=method,
                                     headers={"X-Api-Key": self.key, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                raw = r.read()
        except urllib.error.HTTPError as e:
            captcha = unreachable = False
            # Classify only the known message; never keep or show the body (it may echo secrets).
            if e.code == 400 and path.startswith("api/v1/indexer") and not path.startswith("api/v1/indexerproxy"):
                try:
                    errors = json.loads(e.read(65536).decode("utf-8", "replace"))
                    messages = [str(x.get("errorMessage", "")).lower() for x in errors if isinstance(x, dict)] \
                        if isinstance(errors, list) else []
                    captcha = any(CAPTCHA_TEXT.lower() in m for m in messages)
                    unreachable = any(UNREACHABLE_TEXT in m for m in messages)
                except (ValueError, OSError):
                    pass
            raise ProwlarrError(e.code, path, captcha, unreachable) from None
        text = raw.decode("utf-8", "replace").strip()
        return json.loads(text) if text else {}

    def indexers(self) -> list[tuple[int, str]]:
        return [(i["id"], i.get("name") or "Indexer") for i in self.request("api/v1/indexer")]

    def connection(self, indexer_id: int) -> dict:
        return {"endpoint": urllib.parse.urljoin(self.root, f"{indexer_id}/api"), "apiKey": self.key}

    def apply_rutracker_credentials(self, indexer_id: int, username: str, password: str) -> bool:
        item = self.request(f"api/v1/indexer/{indexer_id}")
        if not is_rutracker(item):
            self.request("api/v1/indexer/test", "POST", item)
            return False
        fields = item.get("fields") or []
        user, pw = _field(fields, "username", "userName"), _field(fields, "password")
        if not user or not pw:
            raise RuntimeError("Это описание RuTracker требует ручной авторизации в Prowlarr")
        if username.strip():
            user["value"] = username.strip()
        if password:
            pw["value"] = password
        self.request("api/v1/indexer/test", "POST", item)  # validate before replacing a working indexer
        self.request(f"api/v1/indexer/{indexer_id}", "PUT", item)
        return True

    def add_rutracker(self, username: str, password: str, proxy_tag: int | None = None) -> int:
        if not username.strip() or not password:
            raise ValueError("Введите логин и пароль RuTracker")
        if any("rutracker" in name.lower() for _, name in self.indexers()):
            raise RuntimeError("RuTracker уже настроен. Выберите существующий индексатор, чтобы сохранить его настройки")
        schema = self.request("api/v1/indexer/schema")
        template = next((t for node in schema for t in templates(node) if is_rutracker(t)), None)
        if not template:
            raise RuntimeError("Описание RuTracker недоступно. Обновите Prowlarr или добавьте индексатор в его интерфейсе")
        profiles = self.request("api/v1/appprofile")
        candidate = prepare_rutracker(template, username, password, (profiles[0].get("id") if profiles else None) or 1)
        if proxy_tag is not None:
            add_tag(candidate, proxy_tag)
        self.request("api/v1/indexer/test", "POST", candidate)
        added = self.request("api/v1/indexer", "POST", candidate)
        if not isinstance(added.get("id"), int):
            raise RuntimeError("Prowlarr не вернул номер индексатора")
        return added["id"]

    def existing_flaresolverr_tag(self, address: str) -> int | None:
        host = validate_address(address)
        tag = next((t["id"] for t in self.request("api/v1/tag") if t.get("label") == TAG), None)
        if tag is None:
            return None
        for p in self.request("api/v1/indexerproxy"):
            if p.get("name") == PROXY_NAME and p.get("implementation") == "FlareSolverr" and tag in (p.get("tags") or []):
                saved = (_field(p.get("fields") or [], "host") or {}).get("value")
                if saved and validate_address(saved) == host:
                    return tag
        return None

    def configure_flaresolverr(self, address: str, probe_address: str | None = None) -> int:
        self.used_tracker_fallback = False
        host = validate_address(address)
        tag = next((t for t in self.request("api/v1/tag") if t.get("label") == TAG), None) \
            or self.request("api/v1/tag", "POST", {"label": TAG})
        tag_id = tag["id"]
        existing = next((p for p in self.request("api/v1/indexerproxy") if p.get("name") == PROXY_NAME), None)
        schema = self.request("api/v1/indexerproxy/schema")
        base = existing or next((p for p in schema if p.get("implementation") == "FlareSolverr"), None)
        if not base:
            raise RuntimeError("Описание прокси FlareSolverr недоступно в Prowlarr")
        proxy = copy.deepcopy(base)
        proxy.pop("presets", None)
        proxy["name"], proxy["tags"] = PROXY_NAME, [tag_id]
        _field(proxy["fields"], "host")["value"] = host
        fallback = False
        try:
            self.request("api/v1/indexerproxy/test", "POST", proxy)
        except ProwlarrError as e:
            # Prowlarr tests its own Cloudflare-protected ping, not the tracker: accept only a
            # confirmed block of that ping while FlareSolverr really opens RuTracker.
            if e.status != 400:
                raise
            probe = validate_address(probe_address or host)
            if probe_flaresolverr(probe, "https://prowlarr.servarr.com/v1/ping") != "blocked" \
                    or probe_flaresolverr(probe, "https://rutracker.org/forum/index.php") != "success":
                raise
            fallback = True
        if fallback and not existing:
            unassigned = copy.deepcopy(proxy)
            unassigned["tags"] = []
            created = self.request("api/v1/indexerproxy", "POST", unassigned)
            pid = created.get("id")
            proxy["id"] = pid
            try:
                self.request(f"api/v1/indexerproxy/{pid}?forceSave=true", "PUT", proxy)
            except Exception:
                try:
                    self.request(f"api/v1/indexerproxy/{pid}", "DELETE")
                except Exception:  # noqa: BLE001 - only our own unassigned proxy
                    pass
                raise
        elif existing:
            self.request(f"api/v1/indexerproxy/{existing['id']}" + ("?forceSave=true" if fallback else ""), "PUT", proxy)
        else:
            self.request("api/v1/indexerproxy" + ("?forceSave=true" if fallback else ""), "POST", proxy)
        self.used_tracker_fallback = fallback
        return tag_id

    def attach_rutracker_proxy(self, indexer_id: int, tag: int) -> None:
        item = self.request(f"api/v1/indexer/{indexer_id}")
        if not is_rutracker(item):
            return
        add_tag(item, tag)
        self.request(f"api/v1/indexer/{indexer_id}", "PUT", item)
        self.request("api/v1/indexer/test", "POST", item)


def probe_flaresolverr(address: str, target: str) -> str:
    """failed | blocked | success — without exposing page HTML or cookies."""
    body = json.dumps({"cmd": "request.get", "url": target, "maxTimeout": 60000}).encode()
    req = urllib.request.Request(urllib.parse.urljoin(address, "v1"), data=body, method="POST",
                                 headers={"Content-Type": "application/json"})
    try:
        try:
            with urllib.request.urlopen(req, timeout=75) as r:
                status, result = r.status, json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            status, result = e.code, json.loads(e.read().decode("utf-8", "replace") or "{}")
    except (OSError, ValueError):
        return "failed"
    if status == 500 and result.get("status") == "error" and \
            "cloudflare has blocked this request." in str(result.get("message", "")).lower():
        return "blocked"
    sol = result.get("solution") or {}
    final = urllib.parse.urlsplit(str(sol.get("url") or ""))
    if status == 200 and result.get("status") == "ok" and sol.get("status") == 200 and final.scheme == "https" \
            and final.hostname == urllib.parse.urlsplit(target).hostname and is_tracker_page(sol):
        return "success"
    return "failed"
