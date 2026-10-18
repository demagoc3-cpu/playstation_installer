"""«Настроить поиск»: a GTK assistant around search.run_setup()."""
from __future__ import annotations

import shutil
import threading
from pathlib import Path

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import GLib, Gtk  # noqa: E402

from . import search  # noqa: E402

STEPS = [("qbittorrent", "qBittorrent — загрузка торрентов"),
         ("flaresolverr", "FlareSolverr — обход Cloudflare (Chromium внутри)"),
         ("prowlarr", "Prowlarr — поиск по трекерам"),
         ("proxy", "Прокси FlareSolverr в Prowlarr"),
         ("rutracker", "RuTracker — вход и индексатор"),
         ("web", "Подключение поиска к PackageFlow")]


def default_downloads() -> Path:
    base = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOWNLOAD) or str(Path.home() / "Downloads")
    return Path(base) / "PackageFlow"


class SearchWizard(Gtk.Assistant):
    def __init__(self, parent=None, on_done=None):
        super().__init__(title="Настройка поиска PackageFlow", transient_for=parent, modal=False)
        self.set_default_size(720, 560)
        self.on_done = on_done
        self.running = False
        st = search.load_state()
        tracker = st.get("tracker") or {}

        # 1. intro
        intro = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=12, margin=24)
        text = Gtk.Label(xalign=0, wrap=True)
        text.set_markup(
            "Мастер автоматически установит и настроит всё для поиска и загрузки игр:\n\n"
            "• <b>qBittorrent-nox</b> — загрузка торрентов (версия без окна, работает как служба);\n"
            "• <b>FlareSolverr</b> + <b>Chrome for Testing</b> — проходит проверку Cloudflare на RuTracker "
            "(стабильная сборка Chrome от Google для автоматизации, ставится в папку PackageFlow);\n"
            "• <b>Prowlarr</b> — поиск по трекеру, подключается к PackageFlow.\n\n"
            "Будет загружено около 660 МБ с GitHub и Google, всё проверяется по контрольным суммам. Компоненты работают как службы "
            "вместе с PackageFlow и доступны только с этого компьютера.")
        intro.pack_start(text, False, False, 0)
        row = Gtk.Box(spacing=12)
        row.pack_start(Gtk.Label(label="Папка загрузок:", xalign=0), False, False, 0)
        self.folder = Gtk.FileChooserButton(title="Папка загрузок", action=Gtk.FileChooserAction.SELECT_FOLDER)
        folder = Path(st.get("downloads") or default_downloads())
        folder.mkdir(parents=True, exist_ok=True)
        self.folder.set_filename(str(folder))
        row.pack_start(self.folder, True, True, 0)
        intro.pack_start(row, False, False, 0)
        self.hidden = Gtk.CheckButton(label="Скрывать окно браузера FlareSolverr"
                                      + ("" if shutil.which("Xvfb") else " (установит xvfb, нужен пароль администратора)"))
        self.hidden.set_active((st.get("flaresolverr") or {}).get("headless", True))
        intro.pack_start(self.hidden, False, False, 0)
        self._page(intro, "Что будет установлено", Gtk.AssistantPageType.INTRO, True)

        # 2. RuTracker
        tr = Gtk.Grid(column_spacing=12, row_spacing=12, margin=24)
        note = Gtk.Label(xalign=0, wrap=True, label="Логин и пароль RuTracker нужны, чтобы Prowlarr искал раздачи. "
                         "Пароль хранится только на этом компьютере (файл с правами 600 и база Prowlarr).")
        tr.attach(note, 0, 0, 2, 1)
        self.user = Gtk.Entry(text=tracker.get("username", ""), hexpand=True)
        self.password = Gtk.Entry(text=tracker.get("password", ""), visibility=False, hexpand=True,
                                  input_purpose=Gtk.InputPurpose.PASSWORD)
        tr.attach(Gtk.Label(label="Логин RuTracker", xalign=0), 0, 1, 1, 1)
        tr.attach(self.user, 1, 1, 1, 1)
        tr.attach(Gtk.Label(label="Пароль", xalign=0), 0, 2, 1, 1)
        tr.attach(self.password, 1, 2, 1, 1)
        self.skip = Gtk.CheckButton(label="Пропустить RuTracker сейчас (установить только компоненты)")
        tr.attach(self.skip, 0, 3, 2, 1)
        for w in (self.user, self.password):
            w.connect("changed", self._validate)
        self.skip.connect("toggled", self._validate)
        self.tracker_page = tr
        self._page(tr, "RuTracker", Gtk.AssistantPageType.CONTENT, False)

        # 3. progress
        prog = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=10, margin=24)
        self.rows = {}
        for key, title in STEPS:
            r = Gtk.Box(spacing=10)
            icon = Gtk.Image.new_from_icon_name("content-loading-symbolic", Gtk.IconSize.MENU)
            icon.set_opacity(0.3)
            r.pack_start(icon, False, False, 0)
            r.pack_start(Gtk.Label(label=title, xalign=0), False, False, 0)
            prog.pack_start(r, False, False, 0)
            self.rows[key] = icon
        self.bar = Gtk.ProgressBar(show_text=True)
        self.bar.set_text("")
        prog.pack_start(self.bar, False, False, 6)
        self.message = Gtk.Label(xalign=0, wrap=True, selectable=True)
        prog.pack_start(self.message, False, False, 0)
        self.manual = Gtk.Button(label="Войти в RuTracker вручную в окне браузера")
        self.manual.set_no_show_all(True)
        self.manual.connect("clicked", self._manual)
        prog.pack_start(self.manual, False, False, 0)
        self.key_box = Gtk.Box(spacing=8)
        self.key_box.set_no_show_all(True)
        self.key_entry = Gtk.Entry(placeholder_text="API-ключ Prowlarr", visibility=False, hexpand=True)
        open_p = Gtk.Button(label="Открыть Prowlarr")
        open_p.connect("clicked", lambda *_: Gtk.show_uri_on_window(self, search.PROWLARR_URL, Gtk.get_current_event_time()))
        for w in (self.key_entry, open_p):
            w.show()
            self.key_box.pack_start(w, w is self.key_entry, True, 0)
        prog.pack_start(self.key_box, False, False, 0)
        self.retry = Gtk.Button(label="Повторить")
        self.retry.set_no_show_all(True)
        self.retry.connect("clicked", lambda *_: self._start())
        prog.pack_start(self.retry, False, False, 0)
        self.progress_page = prog
        self._page(prog, "Установка и настройка", Gtk.AssistantPageType.PROGRESS, False)

        # 4. summary
        self.summary = Gtk.Label(xalign=0, wrap=True, margin=24)
        self._page(self.summary, "Готово", Gtk.AssistantPageType.SUMMARY, True)

        self.connect("prepare", self._prepare)
        self.connect("cancel", self._close)
        self.connect("close", self._close)
        self._validate()
        self.show_all()

    def _page(self, widget, title, kind, complete):
        self.append_page(widget)
        self.set_page_title(widget, title)
        self.set_page_type(widget, kind)
        self.set_page_complete(widget, complete)

    def _validate(self, *_):
        ok = self.skip.get_active() or (self.user.get_text().strip() and self.password.get_text())
        self.user.set_sensitive(not self.skip.get_active())
        self.password.set_sensitive(not self.skip.get_active())
        self.set_page_complete(self.tracker_page, bool(ok))

    def _prepare(self, _a, page):
        if page is self.progress_page and not self.running:
            self._start()

    def _mark(self, key, state):
        icon = self.rows.get(key)
        if not icon:
            return
        name = {"run": "media-playback-start-symbolic", "ok": "emblem-ok-symbolic",
                "fail": "dialog-error-symbolic", "skip": "action-unavailable-symbolic"}[state]
        icon.set_from_icon_name(name, Gtk.IconSize.MENU)
        icon.set_opacity(1.0 if state != "skip" else 0.5)

    def _report(self, step, message):
        def ui():
            prev = self.current_step
            if prev and prev != step and self.states.get(prev) == "run":
                self._set(prev, "ok")
            self.current_step = step
            done = any(w in message for w in ("готов", "подключён", "сохранён", "выполнен", "Используется"))
            self._set(step, "skip" if "пропущен" in message else ("ok" if done else "run"))
            self.message.set_text(message)
            self.bar.set_fraction(0)
            self.bar.set_text("")
            return False
        GLib.idle_add(ui)

    def _set(self, key, state):
        self.states[key] = state
        self._mark(key, state)

    def _progress(self, name, pct):
        def ui():
            self.bar.set_fraction(pct / 100)
            self.bar.set_text(f"Загрузка {name}: {pct}%")
            return False
        GLib.idle_add(ui)

    def _start(self):
        self.running = True
        self.current_step = None
        self.states = {}
        self.retry.hide()
        self.manual.hide()
        self.key_box.hide()
        self.retry.set_label("Повторить")
        opts = search.Options(downloads=Path(self.folder.get_filename() or default_downloads()),
                              username="" if self.skip.get_active() else self.user.get_text().strip(),
                              password="" if self.skip.get_active() else self.password.get_text(),
                              headless=self.hidden.get_active(),
                              prowlarr_key=self.key_entry.get_text())

        def work():
            try:
                st = search.run_setup(opts, self._report, self._progress)
                GLib.idle_add(self._finished, st, None)
            except Exception as e:  # noqa: BLE001 - shown in the wizard
                GLib.idle_add(self._finished, None, e)
        threading.Thread(target=work, daemon=True).start()

    def _finished(self, st, error):
        self.running = False
        if error:
            if self.current_step:
                self._set(self.current_step, "fail")
            self.message.set_text(f"Ошибка: {error}")
            self.retry.show()
            if isinstance(error, search.CaptchaRequired):
                self.manual.show()
            if isinstance(error, search.ProwlarrKeyRequired):
                self.key_box.show()
                self.retry.set_label("Подключить и продолжить")
            return False
        self.set_page_complete(self.progress_page, True)
        self.summary.set_markup(
            "<b>Поиск настроен.</b>\n\nRuTracker подключён, результаты доступны в разделе «Поиск» PackageFlow. "
            "Загрузки сохраняются в выбранную папку." if st.get("configured") else
            "<b>Компоненты установлены.</b>\n\nRuTracker не подключён. Откройте «Настроить поиск» ещё раз, "
            "чтобы ввести логин и пароль.")
        self.next_page()
        if self.on_done:
            self.on_done()
        return False

    def _manual(self, *_):
        self.manual.set_sensitive(False)

        def work():
            try:
                ok = search.manual_login(self._report)
                GLib.idle_add(lambda: (self.manual.set_sensitive(True),
                                       self._start() if ok else self.message.set_text(
                                           "Вход не подтверждён за 10 минут. Попробуйте ещё раз")) and False)
            except Exception as e:  # noqa: BLE001
                GLib.idle_add(lambda: (self.manual.set_sensitive(True), self.message.set_text(f"Ошибка: {e}")) and False)
        threading.Thread(target=work, daemon=True).start()

    def _close(self, *_):
        if self.running:
            self.message.set_text("Настройка продолжается в фоне; окно можно закрыть, когда она завершится")
            return
        self.destroy()
