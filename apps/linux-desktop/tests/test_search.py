"""Host-only tests of the search setup: qBittorrent profile, Prowlarr bootstrap/client, units, assets."""
import base64
import hashlib
import json
import os
import re
import sys
import threading
import unittest
import xml.etree.ElementTree as ET
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from packageflow import prowlarr, search  # noqa: E402
from test_core import TempHome  # noqa: E402


class FakeProwlarr:
    def __init__(self, captcha=False, proxy_test_status=200):
        self.indexers, self.tags, self.proxies, self.calls = [], [], [], []
        self.captcha, self.proxy_test_status = captcha, proxy_test_status
        fake = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def send(self, code, obj):
                b = json.dumps(obj).encode()
                self.send_response(code)
                self.send_header("Content-Length", str(len(b)))
                self.end_headers()
                self.wfile.write(b)

            def body(self):
                n = int(self.headers.get("Content-Length") or 0)
                return json.loads(self.rfile.read(n) or b"null")

            def handle_any(self, method):
                if self.headers.get("X-Api-Key") != "k":
                    return self.send(401, {})
                path = self.path.split("?")[0]
                data = self.body() if method in ("POST", "PUT") else None
                fake.calls.append((method, self.path, data))
                if path == "/api/v1/indexer" and method == "GET":
                    return self.send(200, fake.indexers)
                if path == "/api/v1/indexer/schema":
                    return self.send(200, [{"name": "Other", "fields": []},
                                           {"definitionName": "rutracker", "name": "RuTracker.org", "id": 0,
                                            "fields": [{"name": "username", "value": ""}, {"name": "password", "value": ""}]}])
                if path == "/api/v1/appprofile":
                    return self.send(200, [{"id": 7}])
                if path == "/api/v1/indexer/test":
                    if fake.captcha:
                        return self.send(400, [{"errorMessage": "Введите код подтверждения с картинки"}])
                    return self.send(200, {})
                if path == "/api/v1/indexer" and method == "POST":
                    data["id"] = 11
                    fake.indexers.append(data)
                    return self.send(201, data)
                m = re.match(r"^/api/v1/indexer/(\d+)$", path)
                if m:
                    item = next(i for i in fake.indexers if i["id"] == int(m[1]))
                    if method == "PUT":
                        item.update(data)
                    return self.send(200, item)
                if path == "/api/v1/tag" and method == "GET":
                    return self.send(200, fake.tags)
                if path == "/api/v1/tag" and method == "POST":
                    t = {"id": 3, "label": data["label"]}
                    fake.tags.append(t)
                    return self.send(201, t)
                if path == "/api/v1/indexerproxy/schema":
                    return self.send(200, [{"implementation": "FlareSolverr", "name": "", "presets": [],
                                            "fields": [{"name": "host", "value": ""}, {"name": "requestTimeout", "value": 60}]}])
                if path == "/api/v1/indexerproxy/test":
                    return self.send(fake.proxy_test_status, [] if fake.proxy_test_status == 400 else {})
                if path == "/api/v1/indexerproxy" and method == "GET":
                    return self.send(200, fake.proxies)
                if path == "/api/v1/indexerproxy" and method == "POST":
                    data["id"] = 5
                    fake.proxies.append(data)
                    return self.send(201, data)
                m = re.match(r"^/api/v1/indexerproxy/(\d+)$", path)
                if m and method == "PUT":
                    p = next(p for p in fake.proxies if p["id"] == int(m[1]))
                    p.update(data)
                    return self.send(200, p)
                self.send(404, {})

            def do_GET(self):
                self.handle_any("GET")

            def do_POST(self):
                self.handle_any("POST")

            def do_PUT(self):
                self.handle_any("PUT")

            def do_DELETE(self):
                self.handle_any("DELETE")

        self.srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.srv.server_port}"

    def close(self):
        self.srv.shutdown()


class ProwlarrClientTest(unittest.TestCase):
    def setUp(self):
        self.fake = FakeProwlarr()
        self.addCleanup(self.fake.close)
        self.client = prowlarr.Prowlarr(self.fake.url, "k", timeout=5)

    def test_add_rutracker_with_proxy_tag(self):
        tag = self.client.configure_flaresolverr("http://127.0.0.1:8191/")
        self.assertEqual(tag, 3)
        proxy = self.fake.proxies[0]
        self.assertEqual((proxy["name"], proxy["tags"]), ("PackageFlow FlareSolverr", [3]))
        self.assertEqual(next(f for f in proxy["fields"] if f["name"] == "host")["value"], "http://127.0.0.1:8191/")
        self.assertNotIn("presets", proxy)
        self.assertEqual(self.client.existing_flaresolverr_tag("http://127.0.0.1:8191"), 3)
        idx = self.client.add_rutracker(" user ", "pw", tag)
        added = self.fake.indexers[0]
        self.assertEqual((idx, added["name"], added["appProfileId"], added["priority"], added["tags"]),
                         (11, "RuTracker.org", 7, 25, [3]))
        self.assertEqual([f["value"] for f in added["fields"]], ["user", "pw"])
        self.assertNotIn("presets", added)
        self.assertEqual(self.client.connection(11)["endpoint"], self.fake.url + "/11/api")
        with self.assertRaises(RuntimeError):
            self.client.add_rutracker("u", "p", tag)  # existing one is never duplicated

    def test_captcha_is_recognised(self):
        self.fake.captcha = True
        with self.assertRaises(prowlarr.ProwlarrError) as e:
            self.client.add_rutracker("u", "p")
        self.assertTrue(e.exception.captcha)
        self.assertNotIn("код", str(e.exception))  # body is never echoed

    def test_unreachable_indexer_is_recognised(self):
        self.fake.captcha = False
        orig = self.fake.srv.RequestHandlerClass.handle_any

        def unreachable(handler, method):
            if handler.path.startswith("/api/v1/indexer/test"):
                handler.rfile.read(int(handler.headers.get("Content-Length") or 0))
                return handler.send(400, [{"errorMessage": "Unable to connect to indexer, indexer's server is unavailable."}])
            return orig(handler, method)
        self.fake.srv.RequestHandlerClass.handle_any = unreachable
        with self.assertRaises(prowlarr.ProwlarrError) as e:
            self.client.add_rutracker("u", "p")
        self.assertTrue(e.exception.unreachable)
        self.assertFalse(e.exception.captcha)

    def test_proxy_fallback_only_when_ping_blocked_and_tracker_ok(self):
        self.fake.proxy_test_status = 400
        with mock.patch.object(prowlarr, "probe_flaresolverr", side_effect=["blocked", "success"]):
            tag = self.client.configure_flaresolverr("http://127.0.0.1:8191/")
        self.assertTrue(self.client.used_tracker_fallback)
        self.assertEqual(self.fake.proxies[0]["tags"], [tag])
        self.assertTrue(any("forceSave=true" in c[1] for c in self.fake.calls if c[0] == "PUT"))
        fake2 = FakeProwlarr(proxy_test_status=400)
        self.addCleanup(fake2.close)
        with mock.patch.object(prowlarr, "probe_flaresolverr", side_effect=["blocked", "failed"]), \
                self.assertRaises(prowlarr.ProwlarrError):
            prowlarr.Prowlarr(fake2.url, "k", timeout=5).configure_flaresolverr("http://127.0.0.1:8191/")
        self.assertEqual(fake2.proxies, [])

    def test_tracker_page_detection(self):
        self.assertFalse(prowlarr.is_tracker_page({"response": "<title>Just a moment...</title>", "cookies": [1]}))
        self.assertFalse(prowlarr.is_tracker_page({"response": "<html>ok</html>", "cookies": []}))
        self.assertTrue(prowlarr.is_tracker_page({"response": "<html>RuTracker</html>", "cookies": [{"name": "a"}]}))

    def test_address_validation(self):
        for bad in ("ftp://x", "http://u:p@h", "http://h/?q=1"):
            with self.assertRaises(ValueError):
                prowlarr.validate_address(bad)


class SearchLocalTest(TempHome):
    def test_qbittorrent_password_matches_qt_pbkdf2(self):
        ini = search.qbit_ini(8090, "secret-password-123", self.home / "dl")
        m = re.search(r'Password_PBKDF2="@ByteArray\(([^:]+):([^)]+)\)"', ini)
        salt, digest = base64.b64decode(m[1]), base64.b64decode(m[2])
        self.assertEqual(len(salt), 16)
        self.assertEqual(digest, hashlib.pbkdf2_hmac("sha512", b"secret-password-123", salt, 100000, 64))
        for line in ("WebUI\\Address=127.0.0.1", "WebUI\\Port=8090", "WebUI\\Username=packageflow",
                     f'Downloads\\SavePath="{self.home / "dl"}"', "StartUpWindowState=Hidden"):
            self.assertIn(line, ini)

    def test_prowlarr_bootstrap_new_and_existing(self):
        st = {}
        key = search.bootstrap_prowlarr(st)
        root = ET.parse(search.prowlarr_data() / "config.xml").getroot()
        self.assertEqual((root.findtext("BindAddress"), root.findtext("Port"), root.findtext("ApiKey")), ("127.0.0.1", "9696", key))
        self.assertEqual(st["prowlarr"]["key"], key)
        root.find("BindAddress").text = "*"
        ET.ElementTree(root).write(search.prowlarr_data() / "config.xml")
        self.assertEqual(search.bootstrap_prowlarr({}), key)  # an existing key is kept
        self.assertEqual(ET.parse(search.prowlarr_data() / "config.xml").getroot().findtext("BindAddress"), "127.0.0.1")
        self.assertEqual((search.prowlarr_data() / "config.xml").stat().st_mode & 0o777, 0o600)

    def test_state_file_is_private(self):
        search.save_state({"tracker": {"password": "x"}})
        self.assertEqual(search.state_path().stat().st_mode & 0o777, 0o600)

    def test_component_unit(self):
        text = search.component_unit("flaresolverr", ["/c/flaresolverr/flaresolverr"], {"HEADLESS": "true"}, Path("/c/flaresolverr"))
        for line in ("PartOf=packageflow.service", "WantedBy=packageflow.service", 'Environment="HEADLESS=true"',
                     'ExecStart="/c/flaresolverr/flaresolverr"', "Restart=on-failure"):
            self.assertIn(line, text)

    def test_flaresolverr_chrome_wrapper(self):
        import subprocess
        chrome = self.home / "fs" / "flaresolverr" / "_internal" / "chrome" / "chrome"
        chrome.parent.mkdir(parents=True)
        chrome.write_bytes(b"\x7fELF-real-binary")
        chrome.chmod(0o755)
        self.assertTrue(search.patch_flaresolverr_chrome(self.home / "fs"))
        self.assertFalse(search.patch_flaresolverr_chrome(self.home / "fs"))  # idempotent
        real = chrome.with_name("chrome.real")
        self.assertEqual(real.read_bytes(), b"\x7fELF-real-binary")
        real.write_text('#!/bin/sh\necho "bundled LD=${LD_LIBRARY_PATH-unset} ARGS=$*"\n')
        env = {"PATH": "/usr/bin:/bin", "LD_LIBRARY_PATH": "/x/_internal"}
        self.assertEqual(subprocess.run([str(chrome), "--version"], env=env, capture_output=True, text=True).stdout.strip(),
                         "bundled LD=unset ARGS=--version")
        cft = self.home / "cft" / "chrome"
        cft.parent.mkdir()
        cft.write_text('#!/bin/sh\necho "cft LD=${LD_LIBRARY_PATH-unset} ARGS=$*"\n')
        cft.chmod(0o755)
        self.assertTrue(search.patch_flaresolverr_chrome(self.home / "fs", cft))  # switches target
        self.assertFalse(search.patch_flaresolverr_chrome(self.home / "fs", cft))
        out = subprocess.run([str(chrome), "-x"], env={**env, "LD_LIBRARY_PATH_ORIG": "/usr/local/lib"},
                             capture_output=True, text=True).stdout.strip()
        self.assertEqual(out, "cft LD=/usr/local/lib ARGS=-x")

    def test_latest_asset_requires_digest_and_repo_url(self):
        def rel(assets):
            body = json.dumps({"tag_name": "v1", "assets": assets}).encode()
            r = mock.MagicMock()
            r.__enter__.return_value.read.return_value = body
            return r
        good = {"name": "flaresolverr_linux_x64.tar.gz", "size": 10, "digest": "sha256:" + "a" * 64,
                "browser_download_url": "https://github.com/FlareSolverr/FlareSolverr/releases/download/v1/flaresolverr_linux_x64.tar.gz"}
        with mock.patch("urllib.request.urlopen", return_value=rel([good])):
            self.assertEqual(search.latest_asset("flaresolverr").sha256, "a" * 64)
        for bad in (dict(good, digest=None), dict(good, browser_download_url="https://evil.example/x.tar.gz"),
                    dict(good, name="flaresolverr_windows_x64.zip")):
            with mock.patch("urllib.request.urlopen", return_value=rel([bad])), self.assertRaises(search.SetupError):
                search.latest_asset("flaresolverr")


if __name__ == "__main__":
    unittest.main()
