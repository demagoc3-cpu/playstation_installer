"""Host-only tests: settings, console bundle staging, systemd unit, server env, tray menu layout."""
import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from packageflow import bundle, paths, server, service  # noqa: E402
from packageflow import settings as cfg  # noqa: E402


class TempHome(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        env = {"HOME": str(self.home), "XDG_CONFIG_HOME": str(self.home / "cfg"),
               "XDG_DATA_HOME": str(self.home / "data"), "XDG_STATE_HOME": str(self.home / "state")}
        self.env = mock.patch.dict(os.environ, env)
        self.env.start()
        os.environ.pop("APPIMAGE", None)
        os.environ.pop("PACKAGEFLOW_ROOT", None)

    def tearDown(self):
        self.env.stop()
        self.tmp.cleanup()


class SettingsTest(TempHome):
    def test_defaults_match_windows(self):
        s = cfg.load()
        self.assertEqual((s.port, s.payload_port, s.host_ip), (3000, 3001, ""))
        self.assertEqual(s.web_data_dir, self.home / "data" / "PackageFlow" / "web")

    def test_validation(self):
        for bad in (cfg.Settings(port=80), cfg.Settings(port=3000, payload_port=3000),
                    cfg.Settings(host_ip="127.0.0.1"), cfg.Settings(host_ip="ps5"), cfg.Settings(data_dir="rel")):
            with self.assertRaises(cfg.SettingsError):
                bad.validate()
        cfg.Settings(host_ip="192.168.0.5", data_dir="/srv/pf").validate()

    def test_save_load_and_private_key(self):
        cfg.save(cfg.Settings(port=3100, payload_port=3101))
        self.assertEqual(cfg.load().port, 3100)
        key = cfg.launcher_key()
        self.assertEqual(len(key), 64)
        self.assertEqual(cfg.launcher_key(), key)
        self.assertEqual((paths.config_dir() / "launcher.key").stat().st_mode & 0o777, 0o600)

    def test_unknown_keys_ignored(self):
        cfg.settings_path().parent.mkdir(parents=True)
        cfg.settings_path().write_text(json.dumps({"port": 3200, "future": 1}))
        self.assertEqual(cfg.load().port, 3200)


def make_bundle(d: Path, tamper=False) -> Path:
    d.mkdir(parents=True)
    files = {"elf": ("PackageFlowService-PS5.elf", b"\x7fELF" + b"e" * 100),
             "app": ("PPSA95001-01.000.044.ffpkg", b"a" * 300), "ps4": ("PackageFlowService-2.14.pkg", b"p" * 200)}
    m = {"schemaVersion": 1}
    for role, (name, data) in files.items():
        (d / name).write_bytes(data)
        m[role] = {"fileName": name, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    m["elf"].update(version="0.1.29-dev", buildId="ps5-service-pkg-context-029c-sse2", firmware="13.60")
    m["app"].update(version="01.000.044", buildId="6c32b25")
    m["ps4"].update(version="2.14")
    (d / "manifest.json").write_text(json.dumps(m))
    if tamper:
        (d / files["app"][0]).write_bytes(b"b" * 300)
    return d


class BundleTest(TempHome):
    def test_stage_copies_and_writes_update_release(self):
        src = make_bundle(self.home / "b")
        data = self.home / "web"
        m = bundle.stage(src, data)
        self.assertEqual(m["elf"]["version"], "0.1.29-dev")
        for name in ("PackageFlowService-PS5.elf", "PPSA95001-01.000.044.ffpkg", "PackageFlowService-2.14.pkg", "manifest.json"):
            self.assertTrue((data / "console-setup" / name).is_file())
        rel = json.loads((data / "ps5-service-updates" / "release.json").read_text())
        self.assertEqual((rel["service"], rel["buildId"]), ("PackageFlowService-PS5", "ps5-service-pkg-context-029c-sse2"))
        self.assertEqual(bundle.stage(src, data), m)  # idempotent

    def test_tampered_bundle_refused_and_nothing_staged(self):
        src = make_bundle(self.home / "b", tamper=True)
        with self.assertRaises(bundle.BundleError):
            bundle.stage(src, self.home / "web")
        self.assertFalse((self.home / "web" / "console-setup").exists())

    def test_missing_bundle_allowed(self):
        self.assertIsNone(bundle.stage(self.home / "none", self.home / "web"))

    def test_bad_firmware_refused(self):
        src = make_bundle(self.home / "b")
        m = json.loads((src / "manifest.json").read_text())
        m["elf"]["firmware"] = "12.00"
        (src / "manifest.json").write_text(json.dumps(m))
        with self.assertRaises(bundle.BundleError):
            bundle.verify(src)


class ServiceTest(TempHome):
    def test_unit_for_deb(self):
        with mock.patch.object(paths, "install_root", return_value=Path("/usr/lib/packageflow")):
            text = service.unit_text()
        self.assertIn('ExecStart="/usr/lib/packageflow/bin/packageflow" "--server"', text)
        self.assertIn("WantedBy=default.target", text)
        self.assertIn("Restart=on-failure", text)

    def test_unit_for_appimage_uses_image_path_and_escapes(self):
        with mock.patch.dict(os.environ, {"APPIMAGE": "/home/u/Apps/Package Flow$1%.AppImage"}):
            self.assertEqual(paths.install_kind(), "appimage")
            text = service.unit_text()
        self.assertIn('ExecStart="/home/u/Apps/Package Flow$$1%%.AppImage" "--server"', text)
        self.assertNotIn("Documentation=", text)

    def test_autostart_entry(self):
        with mock.patch.dict(os.environ, {"APPIMAGE": "/opt/PF.AppImage"}):
            service.set_autostart(True)
        text = service.autostart_path().read_text()
        self.assertIn("Exec=/opt/PF.AppImage --tray", text)
        service.set_autostart(False)
        self.assertFalse(service.autostart_path().exists())

    def test_systemd_unavailable_when_disabled(self):
        with mock.patch.dict(os.environ, {"PACKAGEFLOW_NO_SYSTEMD": "1"}):
            self.assertFalse(service.available())


class ServerEnvTest(TempHome):
    def test_environment_matches_windows_server_host(self):
        s = cfg.Settings(port=3100, payload_port=3101, host_ip="192.168.0.5")
        with mock.patch.dict(os.environ, {"PACKAGEFLOW_DEBUG": "1", "NITRO_PORT": "9"}):
            env = server.environment(s, "k" * 64)
        self.assertEqual(env["HOST"], "0.0.0.0")
        self.assertEqual((env["PORT"], env["PACKAGEFLOW_PUBLIC_PORT"], env["PACKAGEFLOW_PAYLOAD_PORT"]), ("3100", "3100", "3101"))
        self.assertEqual(env["PACKAGEFLOW_HOST_IP"], "192.168.0.5")
        self.assertEqual(env["PACKAGEFLOW_LAUNCHER_KEY"], "k" * 64)
        self.assertNotIn("PACKAGEFLOW_DEBUG", env)
        self.assertNotIn("NITRO_PORT", env)

    def test_refuses_busy_port(self):
        import socket
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            sock.listen()
            port = sock.getsockname()[1]
            cfg.save(cfg.Settings(port=port, payload_port=port + 1 if port < 65535 else port - 1))
            self.assertEqual(server.run(), 75)


class RuntimeRootTest(TempHome):
    def make_root(self, built="2026-10-17T00:00:00Z"):
        root = self.home / "mnt" / built.replace(":", "")
        for d in ("runtime", "web/.output/server", "console-setup"):
            (root / d).mkdir(parents=True)
        (root / "runtime" / "node").write_bytes(b"node")
        (root / "web" / ".output" / "server" / "index.mjs").write_text("x")
        (root / "release.json").write_text(json.dumps({"version": "1.10.27", "builtAt": built}))
        return root

    def test_deb_runs_in_place(self):
        root = self.make_root()
        with mock.patch.dict(os.environ, {"PACKAGEFLOW_ROOT": str(root)}):
            self.assertEqual(server.runtime_root(), root)

    def test_appimage_copies_once_and_prunes_old_builds(self):
        a, b = self.make_root("2026-10-17T00:00:00Z"), self.make_root("2026-10-18T00:00:00Z")
        with mock.patch.dict(os.environ, {"APPIMAGE": "/x/PF.AppImage", "PACKAGEFLOW_ROOT": str(a)}):
            first = server.runtime_root()
            self.assertTrue((first / "runtime" / "node").is_file())
            self.assertTrue(str(first).startswith(str(self.home / "data")))
            (first / "marker").write_text("kept")
            self.assertEqual(server.runtime_root(), first)
            self.assertTrue((first / "marker").exists())
        with mock.patch.dict(os.environ, {"APPIMAGE": "/x/PF.AppImage", "PACKAGEFLOW_ROOT": str(b)}):
            second = server.runtime_root()
        self.assertNotEqual(first, second)
        self.assertFalse(first.exists())
        self.assertEqual([p.name for p in second.parent.iterdir()], [second.name])


class TrayLayoutTest(unittest.TestCase):
    def test_layout_signature_and_items(self):
        try:
            from packageflow.sni import Item, layout_variant
        except (ImportError, ValueError):
            self.skipTest("python3-gi недоступен")
        items = [Item("Открыть"), Item(separator=True), Item("Флажок", check=True), Item("Выкл", enabled=False)]
        for n, i in enumerate(items, 1):
            i.id = n
        v = layout_variant(items)
        self.assertEqual(v.get_type_string(), "(ia{sv}av)")
        root_id, props, children = v.unpack()
        self.assertEqual(root_id, 0)
        self.assertEqual(len(children), 4)
        self.assertEqual(children[1][1]["type"], "separator")
        self.assertEqual(children[2][1]["toggle-state"], 1)
        self.assertFalse(children[3][1]["enabled"])


if __name__ == "__main__":
    unittest.main()


def rel(tag, assets, draft=False, pre=False):
    return {"tag_name": tag, "draft": draft, "prerelease": pre, "assets": assets}


def asset(name, data=b"x", url=None, digest=True):
    from packageflow import updates
    return {"name": name, "size": len(data),
            "browser_download_url": url or f"{updates.DOWNLOAD_PREFIX}v1/{name}",
            "digest": "sha256:" + hashlib.sha256(data).hexdigest() if digest else None}


class UpdatesTest(TempHome):
    def test_selects_newest_stable_verified_asset_of_own_kind(self):
        from packageflow import updates
        releases = [
            rel("v1.10.40", [asset("packageflow_1.10.40-1_amd64.deb")], pre=True),
            rel("v1.10.39", [asset("packageflow_1.10.39-1_amd64.deb")], draft=True),
            rel("v1.10.30", [asset("packageflow_1.10.30-1_amd64.deb", digest=False)]),
            rel("v1.10.31", [asset("packageflow_1.10.31-1_amd64.deb", url="https://evil.example/x.deb")]),
            rel("v10.0.1", [asset("packageflow_10.0.1-1_amd64.deb")]),
            rel("v1.10.28", [asset("packageflow_1.10.28-2_amd64.deb"), asset("PackageFlow-1.10.29-x86_64.AppImage")]),
            rel("v1.10.28b", [asset("packageflow_1.10.28-1_amd64.deb")]),
            rel("v1.10.7", [asset("PackageFlowSetup-1.10.7-x64.exe")]),
        ]
        deb = updates.select_latest("deb", releases)
        self.assertEqual((deb.version, deb.key), ("1.10.28", (1, 10, 28, 2)))
        self.assertEqual(updates.select_latest("appimage", releases).version, "1.10.29")
        self.assertIsNone(updates.select_latest("appimage", releases[:5]))

    def test_check_without_linux_assets(self):
        from packageflow import updates
        with mock.patch.dict(os.environ, {"APPIMAGE": "/x/PF.AppImage"}), \
                mock.patch.object(updates, "fetch_releases", return_value=[rel("v1.10.7", [asset("PackageFlowSetup-1.10.7-x64.exe")])]):
            r = updates.check()
        self.assertFalse(r["newer"])
        self.assertIn("ещё не опубликована", r["message"])

    def test_newer_compares_with_installed_release(self):
        from packageflow import updates
        with mock.patch.object(paths, "release", return_value={"version": "1.10.27", "debRevision": 1}), \
                mock.patch.object(paths, "install_kind", return_value="deb"), \
                mock.patch.object(updates, "fetch_releases", return_value=[rel("a", [asset("packageflow_1.10.27-2_amd64.deb")])]):
            r = updates.check()
        self.assertTrue(r["newer"])

    def serve(self, payload: bytes):
        import threading
        from http.server import BaseHTTPRequestHandler, HTTPServer

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                self.send_response(200)
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
        srv = HTTPServer(("127.0.0.1", 0), H)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(srv.shutdown)
        return f"http://127.0.0.1:{srv.server_port}/f"

    def test_download_verifies_and_appimage_replaces_in_place(self):
        from packageflow import updates
        data = b"new appimage" * 1000
        a = updates.Asset("appimage", "1.10.28", (1, 10, 28, 0), "PackageFlow-1.10.28-x86_64.AppImage",
                          self.serve(data), len(data), hashlib.sha256(data).hexdigest())
        target = self.home / "Apps" / "PackageFlow.AppImage"
        target.parent.mkdir()
        target.write_bytes(b"old")
        with mock.patch.dict(os.environ, {"APPIMAGE": str(target)}):
            pct = []
            f = updates.download(a, updates.download_path(a), pct.append)
            self.assertEqual(pct[-1], 100)
            self.assertEqual(updates.install(a, f), [str(target)])
        self.assertEqual(target.read_bytes(), data)
        self.assertTrue(os.access(target, os.X_OK))
        self.assertEqual([p.name for p in target.parent.iterdir()], ["PackageFlow.AppImage"])

    def test_tampered_download_leaves_nothing(self):
        from packageflow import updates
        data = b"payload" * 100
        a = updates.Asset("deb", "1.10.28", (1, 10, 28, 1), "packageflow_1.10.28-1_amd64.deb",
                          self.serve(data), len(data), "0" * 64)
        dest = self.home / "u" / a.name
        with self.assertRaises(updates.UpdateError):
            updates.download(a, dest)
        self.assertFalse(dest.exists())
        self.assertFalse(dest.with_name(dest.name + ".part").exists())


class SupportTest(TempHome):
    def test_loads_valid_wallets_and_skips_malformed(self):
        from packageflow import support
        root = self.home / "root"
        (root / "assets").mkdir(parents=True)
        qr = [[True, False], [False, True]]
        (root / "assets" / "donations.json").write_text(json.dumps([
            {"Name": "Bitcoin (BTC)", "Network": "Bitcoin", "Address": "17jXaJmM4jki1gwQmzo4ep9U4Sb6iiZXWG", "Qr": qr},
            {"Name": "Bad", "Network": "x", "Address": "not an address!", "Qr": qr},
            {"Name": "NoQr", "Network": "x", "Address": "TRMH7kJxydeBxjbyu2FRmraoDzkx6mRa9v", "Qr": [[True]] * 2},
        ]))
        with mock.patch.dict(os.environ, {"PACKAGEFLOW_ROOT": str(root)}):
            wallets = support.load()
        self.assertEqual([w.name for w in wallets], ["Bitcoin (BTC)"])
        self.assertEqual(wallets[0].qr, ((True, False), (False, True)))

    def test_missing_file_is_empty(self):
        from packageflow import support
        with mock.patch.dict(os.environ, {"PACKAGEFLOW_ROOT": str(self.home)}):
            self.assertEqual(support.load(), [])
