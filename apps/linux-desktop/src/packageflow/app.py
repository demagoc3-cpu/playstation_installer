"""PackageFlow for Linux: window (WebKitGTK) + tray + control of the WEB service."""
from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gio, GLib, Gtk  # noqa: E402

try:
    gi.require_version("WebKit2", "4.1")
    from gi.repository import WebKit2  # noqa: E402
except (ValueError, ImportError):
    WebKit2 = None

from . import api, paths, search, service, support, updates  # noqa: E402
from . import settings as cfg  # noqa: E402
from .sni import Item, Tray  # noqa: E402

APP_ID = os.environ.get("PACKAGEFLOW_APP_ID", "io.packageflow.PackageFlow")  # override only for tests
POLL_SECONDS = 5

LOADING_HTML = """<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark}body{margin:0;height:100vh;display:grid;place-items:center;
font:15px system-ui,sans-serif;background:Canvas;color:CanvasText}p{opacity:.7}</style></head>
<body><div style="text-align:center"><h2>PackageFlow</h2><p>%s</p></div></body></html>"""


def run_async(work, done=None):
    """Runs work() in a thread; done(result, error) on the GTK thread."""
    def target():
        try:
            result, error = work(), None
        except Exception as e:  # noqa: BLE001 - reported to the user
            result, error = None, e
        if done:
            GLib.idle_add(lambda: done(result, error) and False)
    threading.Thread(target=target, daemon=True).start()


def local_ipv4() -> list[str]:
    try:
        out = subprocess.run(["ip", "-j", "-4", "addr"], capture_output=True, text=True, timeout=5).stdout
        return [a["local"] for i in json.loads(out) for a in i.get("addr_info", [])
                if not a["local"].startswith("127.")]
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return []


def paint_qr(cr, size: float, matrix) -> None:
    """Black modules on white with the standard 4-module quiet zone."""
    n = len(matrix)
    cell = size / (n + 8)
    cr.set_source_rgb(1, 1, 1)
    cr.rectangle(0, 0, size, size)
    cr.fill()
    cr.set_source_rgb(0, 0, 0)
    for y, row in enumerate(matrix):
        for x, dark in enumerate(row):
            if dark:
                cr.rectangle((x + 4) * cell, (y + 4) * cell, cell + 0.5, cell + 0.5)
    cr.fill()


class MainWindow(Gtk.ApplicationWindow):
    def __init__(self, app: "App"):
        super().__init__(application=app, title="PackageFlow")
        self.app = app
        self.set_default_size(1280, 860)
        self.set_icon_name("packageflow")
        self.connect("delete-event", self._hide)
        self.connect("key-press-event", self._keys)
        self.retry = None
        if WebKit2:
            ctx = WebKit2.WebContext.get_default()
            ctx.connect("download-started", self._download)
            self.view = WebKit2.WebView.new_with_context(ctx)
            self.view.get_settings().set_enable_developer_extras(False)
            self.view.connect("load-failed", self._failed)
            self.view.connect("create", self._new_window)
            self.view.connect("decide-policy", self._policy)
            self.add(self.view)
        else:
            box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin=48, valign=Gtk.Align.CENTER)
            box.pack_start(Gtk.Label(label="Для окна приложения нужен WebKitGTK (gir1.2-webkit2-4.1).\n"
                                           "Интерфейс можно открыть в браузере.", justify=Gtk.Justification.CENTER),
                           False, False, 0)
            b = Gtk.Button(label="Открыть в браузере", halign=Gtk.Align.CENTER)
            b.connect("clicked", lambda *_: app.open_browser())
            box.pack_start(b, False, False, 0)
            self.view = None
            self.add(box)
        self.show_all()

    def load(self):
        if not self.view:
            return

        def done(foreign, _e):
            if foreign:  # do not show another program's page as PackageFlow
                text = GLib.markup_escape_text(self.app.port_text())
                self.view.load_html("<body style='font:15px sans-serif;background:#10131c;color:#e8ecf6;"
                                    "display:grid;place-items:center;height:90vh'><div style='max-width:560px'>"
                                    f"<h2>Порт занят</h2><p>{text}</p></div></body>", None)
            else:
                self.view.load_uri(self.app.url())
        run_async(lambda: not api.status(timeout=1.5) and api.foreign_port(), done)

    def reload(self):
        if self.view and (self.view.get_uri() or "").startswith("http://127.0.0.1"):
            self.view.reload()
        else:
            self.load()  # the port message page: check the port again

    def _keys(self, _w, event):
        from gi.repository import Gdk
        ctrl = event.state & Gdk.ModifierType.CONTROL_MASK
        if event.keyval == Gdk.KEY_F5 or (ctrl and event.keyval in (Gdk.KEY_r, Gdk.KEY_R)):
            self.reload()
            return True
        return False

    def capture_when_loaded(self, path: str):
        """Diagnostics (PACKAGEFLOW_SCREENSHOT): save the window as PNG after the page loads, then quit."""
        from gi.repository import Gdk

        def shot():
            w = self.get_window()
            pix = Gdk.pixbuf_get_from_window(w, 0, 0, w.get_width(), w.get_height())
            pix.savev(path, "png", [], [])
            self.app.quit_app()
            return False

        def changed(view, event):
            if event == WebKit2.LoadEvent.FINISHED and view.get_uri().startswith("http://127.0.0.1"):
                GLib.timeout_add(2500, shot)
        if self.view:
            self.view.connect("load-changed", changed)

    def _failed(self, view, event, uri, error):
        if uri.startswith("http://127.0.0.1"):
            view.load_html(LOADING_HTML % "Запуск службы PackageFlow…", None)
            if not self.retry:
                self.retry = GLib.timeout_add_seconds(2, self._retry)
            return True
        return False

    def _retry(self):
        self.retry = None
        self.load()
        return False

    def _new_window(self, view, action):
        uri = action.get_request().get_uri()
        if uri:
            Gtk.show_uri_on_window(self, uri, Gtk.get_current_event_time())
        return None

    def _policy(self, view, decision, kind):
        if kind == WebKit2.PolicyDecisionType.NEW_WINDOW_ACTION:
            uri = decision.get_navigation_action().get_request().get_uri()
            Gtk.show_uri_on_window(self, uri, Gtk.get_current_event_time())
            decision.ignore()
            return True
        return False

    def _download(self, ctx, download):
        def destination(dl, suggested):
            folder = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or str(Path.home())
            dl.set_destination(GLib.filename_to_uri(os.path.join(folder, os.path.basename(suggested)), None))
            return True
        download.connect("decide-destination", destination)

    def _hide(self, *_):
        self.hide()
        return True


class SettingsDialog(Gtk.Dialog):
    def __init__(self, parent, s: cfg.Settings):
        super().__init__(title="Настройки PackageFlow", transient_for=parent, modal=True)
        self.add_buttons("Отмена", Gtk.ResponseType.CANCEL, "Сохранить", Gtk.ResponseType.OK)
        self.set_default_response(Gtk.ResponseType.OK)
        grid = Gtk.Grid(column_spacing=12, row_spacing=10, margin=18)
        self.get_content_area().add(grid)
        self.port = Gtk.SpinButton.new_with_range(1024, 65535, 1)
        self.port.set_value(s.port)
        self.payload = Gtk.SpinButton.new_with_range(1024, 65535, 1)
        self.payload.set_value(s.payload_port)
        self.ip = Gtk.ComboBoxText.new_with_entry()
        self.ip.append_text("Автоматически")
        for a in local_ipv4():
            self.ip.append_text(a)
        self.ip.get_child().set_text(s.host_ip or "Автоматически")
        self.data = Gtk.FileChooserButton(title="Каталог данных WEB", action=Gtk.FileChooserAction.SELECT_FOLDER)
        self.data.set_filename(str(s.web_data_dir))
        rows = [("Порт WEB", self.port), ("Порт передачи на приставку", self.payload),
                ("IP этого компьютера в сети", self.ip), ("Каталог данных WEB", self.data)]
        for n, (label, widget) in enumerate(rows):
            grid.attach(Gtk.Label(label=label, xalign=0), 0, n, 1, 1)
            widget.set_hexpand(True)
            grid.attach(widget, 1, n, 1, 1)
        note = Gtk.Label(label="Изменения применяются после перезапуска службы.", xalign=0)
        note.get_style_context().add_class("dim-label")
        grid.attach(note, 0, len(rows), 2, 1)
        self.show_all()

    def result(self, s: cfg.Settings) -> cfg.Settings:
        ip = self.ip.get_child().get_text().strip()
        data = self.data.get_filename() or ""
        return cfg.Settings(port=int(self.port.get_value()), payload_port=int(self.payload.get_value()),
                            host_ip="" if ip in ("", "Автоматически") else ip,
                            data_dir="" if data == str(cfg.Settings().web_data_dir) else data,
                            start_at_login=s.start_at_login, first_run_done=s.first_run_done)


class App(Gtk.Application):
    def __init__(self, start_hidden: bool):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.DEFAULT_FLAGS)
        self.start_hidden = start_hidden
        self.window: MainWindow | None = None
        self.tray: Tray | None = None
        self.child: subprocess.Popen | None = None
        self.systemd = False
        self.state = {"service": "unknown", "web": None}
        self.busy = False
        self.update: dict | None = None
        self.update_progress: int | None = None

    # ---------------------------------------------------------------- lifecycle
    def do_startup(self):
        Gtk.Application.do_startup(self)
        Gtk.IconTheme.get_default().append_search_path(str(paths.icon_theme_dir()))
        Gtk.Window.set_default_icon_name("packageflow")
        self.hold()
        import signal
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, sig, lambda *_: self.quit_app() or False)
        self.systemd = service.available()
        s = cfg.load()
        try:
            if not s.first_run_done:
                s.first_run_done = True
                cfg.save(s)
                service.apply_start_at_login(s)
            elif self.systemd:
                service.ensure_unit()
        except (OSError, service.ServiceError, cfg.SettingsError) as e:
            self.error("Не удалось настроить службу", str(e))
        try:
            self.tray = Tray("PackageFlow", "packageflow", str(paths.icon_theme_dir() / "hicolor" / "scalable" / "apps"),
                             self.show_window)
        except GLib.Error as e:
            print(f"[packageflow] трей недоступен: {e.message}", file=sys.stderr)
        self.start_service(quiet=True)
        self.refresh()
        GLib.timeout_add_seconds(POLL_SECONDS, self.refresh)
        GLib.timeout_add_seconds(20, lambda: self.check_updates(quiet=True) or False)

    def do_activate(self):
        if self.start_hidden:
            self.start_hidden = False
            return
        self.show_window()

    def do_shutdown(self):
        if self.tray:
            self.tray.close()
        if self.child and self.child.poll() is None:
            self.child.terminate()
        Gtk.Application.do_shutdown(self)

    # ---------------------------------------------------------------- helpers
    def url(self) -> str:
        return f"http://127.0.0.1:{cfg.load().port}/"

    def port_text(self) -> str:
        return (f"Порт {cfg.load().port} занят другой программой или другой копией PackageFlow, поэтому служба "
                "не запускается. Закройте её или выберите другой порт WEB в «Настройки…».")

    def show_window(self):
        if not self.window:
            self.window = MainWindow(self)
            if os.environ.get("PACKAGEFLOW_SCREENSHOT"):
                self.window.capture_when_loaded(os.environ["PACKAGEFLOW_SCREENSHOT"])
            self.window.load()
        self.window.show_all()
        self.window.present()

    def open_browser(self):
        Gio.AppInfo.launch_default_for_uri(self.url(), None)

    def error(self, title: str, text: str):
        d = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.ERROR,
                              buttons=Gtk.ButtonsType.CLOSE, text=title)
        d.format_secondary_text(text)
        d.run()
        d.destroy()

    def confirm(self, title: str, text: str, ok: str) -> bool:
        d = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.WARNING,
                              buttons=Gtk.ButtonsType.NONE, text=title)
        d.format_secondary_text(text)
        d.add_buttons("Отмена", Gtk.ResponseType.CANCEL, ok, Gtk.ResponseType.OK)
        r = d.run()
        d.destroy()
        return r == Gtk.ResponseType.OK

    # ---------------------------------------------------------------- service control
    def service_state(self) -> str:
        if self.systemd:
            return service.state()
        return "active" if self.child and self.child.poll() is None else "inactive"

    def start_service(self, quiet=False):
        def work():
            if self.systemd:
                service.start()
            elif not (self.child and self.child.poll() is None):
                log = paths.state_dir() / "server.log"
                log.parent.mkdir(parents=True, exist_ok=True)
                main = Path(__file__).resolve().parents[1] / "main.py"
                self.child = subprocess.Popen([sys.executable, "-I", str(main), "--server"],
                                              stdout=log.open("ab"), stderr=subprocess.STDOUT)
        self._run(work, None if quiet else "Не удалось запустить службу")

    def stop_service(self, force=False, then=None, allow_force=True):
        def work():
            if self.systemd:
                return service.stop(force)
            if api.status() and not force:
                reply = api.prepare_stop()
                if reply.get("busy") is not False:
                    raise service.ServiceError("Есть активные задания")
            if self.child and self.child.poll() is None:
                self.child.terminate()
                self.child.wait(30)

        def done(_r, e):
            self.busy = False
            if isinstance(e, service.ServiceError) and not force:
                if not allow_force:
                    self.error("Действие отложено", "Есть активные задания на приставках. Дождитесь их завершения "
                                                   "и повторите — задания не прерываются.")
                elif self.confirm("Есть активные задания", str(e), "Остановить принудительно"):
                    self.stop_service(True, then)
                return
            if e:
                self.error("Не удалось остановить службу", str(e))
            elif then:
                then()
            self.refresh()
        self.busy = True
        self.refresh_menu()
        run_async(work, done)

    def restart_service(self):
        self.stop_service(then=lambda: self.start_service())

    def _run(self, work, error_title):
        def done(_r, e):
            self.busy = False
            if e and error_title:
                self.error(error_title, str(e))
            self.refresh()
        self.busy = True
        self.refresh_menu()
        run_async(work, done)

    # ---------------------------------------------------------------- tray menu
    def refresh(self):
        def work():
            web = api.status(timeout=1.5)
            return {"service": self.service_state(), "web": web, "foreignPort": not web and api.foreign_port()}

        def done(result, _e):
            if result:
                self.state = result
            self.refresh_menu()
        run_async(work, done)
        return True

    def status_text(self) -> str:
        svc, web = self.state["service"], self.state["web"]
        if self.busy:
            return "Служба: выполняется действие…"
        if self.state.get("foreignPort"):
            return f"Порт {cfg.load().port} занят другой программой"
        if svc == "active" and web:
            return f"Служба работает · порт {cfg.load().port}"
        if svc in ("active", "activating"):
            return "Служба запускается…"
        if svc == "failed":
            return "Служба остановилась с ошибкой"
        if svc == "not-installed":
            return "Служба не установлена"
        return "Служба остановлена"

    def refresh_menu(self):
        if not self.tray:
            return
        svc = self.state["service"]
        running = svc in ("active", "activating")
        s = cfg.load()
        items = [Item("Открыть PackageFlow", self.show_window),
                 Item("Открыть в браузере", self.open_browser),
                 Item(separator=True),
                 Item(self.status_text(), enabled=False)]
        info = self._running_info()
        if running and info and info.get("version") != paths.release().get("version"):
            items.append(Item("Установлена новая версия — перезапустите службу", enabled=False))
        items += [Item("Остановить службу" if running else "Запустить службу",
                       self.stop_service if running else self.start_service, enabled=not self.busy),
                  Item("Перезапустить службу", self.restart_service, enabled=not self.busy and running),
                  Item(separator=True),
                  Item("Запускать при входе в систему", self.toggle_login, check=s.start_at_login),
                  Item("Настроить поиск…" if not search.load_state().get("configured")
                       else "Поиск настроен — изменить…", self.open_search_wizard),
                  Item("Настройки…", self.open_settings),
                  Item("Журнал службы", self.open_journal),
                  Item(separator=True)]
        up = self.update
        if self.update_progress is not None:
            items.append(Item(f"Загрузка обновления… {self.update_progress}%", enabled=False))
        elif up and up.get("newer"):
            items.append(Item(f"Установить обновление {up['available'].version}", self.install_update, enabled=not self.busy))
        items += [Item("Проверить обновления", self.check_updates),
                  Item("Поддержать проект…", self.open_support),
                  Item(separator=True)]
        if self.systemd:
            items += [Item("Закрыть окно и значок (служба продолжит работу)", self.quit_app),
                      Item("Выйти и остановить службу", self.quit_and_stop, enabled=not self.busy)]
        else:
            items.append(Item("Выход", self.quit_app))
        self.tray.set_menu(items)
        self.tray.set_tooltip(f"PackageFlow {paths.release().get('version')}\n{self.status_text()}")

    def _running_info(self) -> dict | None:
        try:
            return json.loads((paths.state_dir() / "server.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def toggle_login(self):
        s = cfg.load()
        s.start_at_login = not s.start_at_login
        try:
            cfg.save(s)
            service.apply_start_at_login(s)
        except (OSError, service.ServiceError) as e:
            self.error("Не удалось изменить автозапуск", str(e))
        self.refresh_menu()

    def open_settings(self):
        s = cfg.load()
        d = SettingsDialog(self.window, s)
        while d.run() == Gtk.ResponseType.OK:
            new = d.result(s)
            try:
                new.validate()
            except cfg.SettingsError as e:
                self.error("Проверьте настройки", str(e))
                continue
            cfg.save(new)
            d.destroy()
            if (new.port, new.payload_port, new.host_ip, new.data_dir) != (s.port, s.payload_port, s.host_ip, s.data_dir) \
                    and self.service_state() == "active" \
                    and self.confirm("Перезапустить службу?", "Новые настройки применятся после перезапуска.", "Перезапустить"):
                self.restart_service()
            return
        d.destroy()

    def open_journal(self):
        w = Gtk.Window(title="Журнал службы PackageFlow")
        w.set_default_size(900, 560)
        view = Gtk.TextView(editable=False, monospace=True, wrap_mode=Gtk.WrapMode.WORD_CHAR, left_margin=8)
        text = service.journal() if self.systemd else self._file_log()
        view.get_buffer().set_text(text or "Записей нет")
        sw = Gtk.ScrolledWindow()
        sw.add(view)
        w.add(sw)
        w.show_all()
        GLib.idle_add(lambda: view.scroll_to_iter(view.get_buffer().get_end_iter(), 0, False, 0, 1) and False)

    def _file_log(self) -> str:
        try:
            return (paths.state_dir() / "server.log").read_text(encoding="utf-8", errors="replace")[-200_000:]
        except OSError:
            return ""

    # ---------------------------------------------------------------- updates
    def info(self, title: str, text: str):
        d = Gtk.MessageDialog(transient_for=self.window, modal=True, message_type=Gtk.MessageType.INFO,
                              buttons=Gtk.ButtonsType.CLOSE, text=title)
        d.format_secondary_text(text)
        d.run()
        d.destroy()

    def check_updates(self, quiet=False):
        def done(result, e):
            if e:
                if not quiet:
                    self.error("Проверка обновлений", str(e))
                return
            self.update = result
            self.refresh_menu()
            if not quiet:
                self.info("Обновления PackageFlow", f"Установлена версия {result['installed']}.\n{result['message']}")
        run_async(updates.check, done)

    def install_update(self):
        up = self.update
        if not up or not up.get("newer") or self.busy:
            return
        asset = up["available"]
        if not self.confirm(f"Обновить PackageFlow до {asset.version}?",
                            "Обновление будет загружено и проверено по SHA-256. Служба остановится, только если "
                            "нет активных заданий. Настройки, библиотека и ключи сохраняются.", "Обновить"):
            return
        was_running = self.service_state() in ("active", "activating")

        def progress(pct):
            def show():
                self.update_progress = pct
                self.refresh_menu()
            GLib.idle_add(show)

        def downloaded(file, e):
            self.update_progress = None
            if e:
                self.refresh_menu()
                self.error("Не удалось загрузить обновление", str(e))
                return
            self.stop_service(then=lambda: self._apply_update(asset, file, was_running), allow_force=False)
        self.update_progress = 0
        self.refresh_menu()
        run_async(lambda: updates.download(asset, updates.download_path(asset), progress), downloaded)

    def _apply_update(self, asset, file, was_running):
        def work():
            command = updates.install(asset, file)
            if was_running and self.systemd:
                service.ensure_unit()
                service.start()
            return command

        def done(command, e):
            if e:
                self.error("Обновление не установлено", str(e))
                if was_running:
                    self.start_service()
                return
            if self.tray:
                self.tray.close()
            if self.child and self.child.poll() is None:
                self.child.terminate()
            os.execv(command[0], command)  # the new version replaces this window and tray
        run_async(work, done)

    # ---------------------------------------------------------------- search
    def open_search_wizard(self):
        if getattr(self, "search_wizard", None):
            self.search_wizard.present()
            return
        if self.state.get("foreignPort"):
            self.error("Порт занят", self.port_text())
            return
        if self.state.get("service") not in ("active", "activating") or not self.state.get("web"):
            self.error("Служба не запущена", "Запустите службу PackageFlow, затем откройте настройку поиска.")
            return
        from .wizard import SearchWizard
        self.search_wizard = SearchWizard(self.window, on_done=self._search_done)
        self.search_wizard.connect("destroy", lambda *_: setattr(self, "search_wizard", None))
        self.search_wizard.present()

    def _search_done(self):
        self.refresh_menu()
        if self.window:
            self.window.reload()  # the Search page reads its source only when it loads

    # ---------------------------------------------------------------- support
    def open_support(self):
        wallets = support.load()
        w = Gtk.Window(title="Поддержать проект")
        w.set_default_size(620, -1)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=14, margin=22)
        w.add(box)
        title = Gtk.Label(xalign=0)
        title.set_markup("<span size='x-large' weight='bold'>Поддержать PackageFlow</span>")
        box.pack_start(title, False, False, 0)
        text = Gtk.Label(label=support.TEXT, xalign=0, wrap=True)
        box.pack_start(text, False, False, 0)
        first_button = None
        if not wallets:
            box.pack_start(Gtk.Label(label="Адреса кошельков не найдены в этой сборке.", xalign=0), False, False, 0)
        for wallet in wallets:
            frame = Gtk.Frame()
            inner = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=14)
            frame.add(inner)
            head = Gtk.Label(xalign=0)
            head.set_markup(f"<b>{GLib.markup_escape_text(wallet.name)}</b> · {GLib.markup_escape_text(wallet.network)}")
            inner.pack_start(head, False, False, 0)
            address = Gtk.Label(label=wallet.address, xalign=0, selectable=True)
            address.get_style_context().add_class("monospace")
            inner.pack_start(address, False, False, 0)
            row = Gtk.Box(spacing=8)
            copy = Gtk.Button(label="Копировать адрес")
            copy.connect("clicked", lambda _b, a=wallet.address: self._copy(a))
            qr = Gtk.Button(label="QR-код")
            qr.connect("clicked", lambda _b, wl=wallet: self._show_qr(w, wl))
            first_button = first_button or copy
            row.pack_start(copy, False, False, 0)
            row.pack_start(qr, False, False, 0)
            inner.pack_start(row, False, False, 0)
            box.pack_start(frame, False, False, 0)
        w.show_all()
        if first_button:
            first_button.grab_focus()  # otherwise the first address opens fully selected
        w.present()

    def _copy(self, text: str):
        from gi.repository import Gdk
        Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD).set_text(text, -1)
        if self.tray:
            self.tray.set_tooltip("Адрес скопирован")

    def _show_qr(self, parent, wallet):
        d = Gtk.Dialog(title=f"{wallet.name} · {wallet.network}", transient_for=parent, modal=True)
        d.add_button("Закрыть", Gtk.ResponseType.CLOSE)
        area = Gtk.DrawingArea()
        area.set_size_request(360, 360)
        area.connect("draw", lambda widget, cr: paint_qr(
            cr, min(widget.get_allocated_width(), widget.get_allocated_height()), wallet.qr))
        content = d.get_content_area()
        content.set_spacing(10)
        content.pack_start(area, True, True, 12)
        content.pack_start(Gtk.Label(label=wallet.address, selectable=True), False, False, 6)
        d.show_all()
        d.run()
        d.destroy()

    def quit_and_stop(self):
        """Full exit: the same guarded stop as the menu item (asks when jobs are active), then quit."""
        if self.service_state() in ("active", "activating"):
            self.stop_service(then=self.quit_app)
        else:
            self.quit_app()

    def quit_app(self):
        self.release()
        self.quit()


def main(start_hidden: bool) -> int:
    app = App(start_hidden)
    app.register(None)
    if app.get_is_remote() and start_hidden:
        return 0  # already running: a second autostart must not pop the window up
    return app.run([sys.argv[0]])
