"""Entry point: `packageflow [--tray | --server | --status | --stop [--force] | --install-service | --version]`."""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from packageflow import paths  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(prog="packageflow", description="PackageFlow для Linux")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--tray", action="store_true", help="запустить в области уведомлений без окна")
    g.add_argument("--server", action="store_true", help="запустить WEB-сервер в этом процессе (для systemd)")
    g.add_argument("--status", action="store_true", help="состояние службы в JSON")
    g.add_argument("--start", action="store_true", help="запустить службу")
    g.add_argument("--stop", action="store_true", help="остановить службу, если нет активных заданий")
    g.add_argument("--install-service", action="store_true", help="установить и включить службу без окна")
    g.add_argument("--remove-service", action="store_true", help="выключить службу и автозапуск")
    g.add_argument("--check-update", action="store_true", help="проверить обновления в GitHub Releases")
    g.add_argument("--update", action="store_true", help="загрузить, проверить и установить обновление")
    g.add_argument("--version", action="store_true")
    ap.add_argument("--force", action="store_true", help="с --stop: остановить даже при активных заданиях")
    a = ap.parse_args()

    if a.version:
        print(json.dumps({**paths.release(), "kind": paths.install_kind(), "root": str(paths.install_root())},
                         ensure_ascii=False))
        return 0
    if a.server:
        from packageflow import server
        return server.run()

    if a.check_update or a.update:
        from packageflow import service, updates
        try:
            r = updates.check()
            asset = r["available"]
            print(json.dumps({**r, "available": asset.__dict__ if asset else None}, ensure_ascii=False))
            if not (a.update and r["newer"]):
                return 0
            file = updates.download(asset, updates.download_path(asset))
            was_running = service.available() and service.state() == "active"
            if was_running:
                service.stop(False)  # never interrupts active console jobs
            updates.install(asset, file)
            if was_running:
                service.ensure_unit()
                service.start()
            print(f"Установлена версия {asset.version}")
            return 0
        except (updates.UpdateError, service.ServiceError, OSError) as e:
            print(f"packageflow: {e}", file=sys.stderr)
            return 1

    from packageflow import api, service
    from packageflow import settings as cfg
    try:
        if a.status:
            st = api.status()
            print(json.dumps({"service": service.state() if service.available() else "no-systemd",
                              "web": st, "port": cfg.load().port, **paths.release()}, ensure_ascii=False))
            return 0 if st else 3
        if a.start:
            service.start()
            return 0
        if a.stop:
            service.stop(a.force)
            return 0
        if a.install_service:
            s = cfg.load()
            s.start_at_login, s.first_run_done = True, True
            cfg.save(s)
            service.ensure_unit()
            service.set_enabled(True)
            service.start()
            print("Служба packageflow.service включена и запущена. Для работы без входа в систему: "
                  "loginctl enable-linger $USER")
            return 0
        if a.remove_service:
            s = cfg.load()
            s.start_at_login = False
            cfg.save(s)
            service.stop(a.force)
            service.apply_start_at_login(s)
            return 0
    except (service.ServiceError, api.ApiError, cfg.SettingsError, OSError) as e:
        print(f"packageflow: {e}", file=sys.stderr)
        return 1

    try:
        from packageflow import app
    except (ImportError, ValueError) as e:
        print(f"packageflow: графический интерфейс недоступен ({e}). Нужны python3-gi и gir1.2-gtk-3.0.\n"
              "Служба работает и без окна: packageflow --install-service", file=sys.stderr)
        return 1
    return app.main(start_hidden=a.tray)


if __name__ == "__main__":
    sys.exit(main())
