"""Tray icon over D-Bus: org.kde.StatusNotifierItem + com.canonical.dbusmenu.

Shown by GNOME (Ubuntu AppIndicator extension), KDE, XFCE, Cinnamon and
others. No libappindicator needed: only python3-gi (Gio).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Callable

from gi.repository import Gio, GLib

SNI_XML = """<node><interface name="org.kde.StatusNotifierItem">
<property name="Category" type="s" access="read"/><property name="Id" type="s" access="read"/>
<property name="Title" type="s" access="read"/><property name="Status" type="s" access="read"/>
<property name="WindowId" type="i" access="read"/><property name="IconName" type="s" access="read"/>
<property name="IconThemePath" type="s" access="read"/><property name="AttentionIconName" type="s" access="read"/>
<property name="OverlayIconName" type="s" access="read"/><property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
<property name="ItemIsMenu" type="b" access="read"/><property name="Menu" type="o" access="read"/>
<method name="ContextMenu"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="Activate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="SecondaryActivate"><arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/></method>
<method name="Scroll"><arg name="delta" type="i" direction="in"/><arg name="orientation" type="s" direction="in"/></method>
<signal name="NewTitle"/><signal name="NewIcon"/><signal name="NewAttentionIcon"/><signal name="NewOverlayIcon"/>
<signal name="NewToolTip"/><signal name="NewStatus"><arg name="status" type="s"/></signal>
</interface></node>"""

MENU_XML = """<node><interface name="com.canonical.dbusmenu">
<property name="Version" type="u" access="read"/><property name="TextDirection" type="s" access="read"/>
<property name="Status" type="s" access="read"/><property name="IconThemePath" type="as" access="read"/>
<method name="GetLayout"><arg type="i" direction="in"/><arg type="i" direction="in"/><arg type="as" direction="in"/>
<arg type="u" direction="out"/><arg type="(ia{sv}av)" direction="out"/></method>
<method name="GetGroupProperties"><arg type="ai" direction="in"/><arg type="as" direction="in"/><arg type="a(ia{sv})" direction="out"/></method>
<method name="GetProperty"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="out"/></method>
<method name="Event"><arg type="i" direction="in"/><arg type="s" direction="in"/><arg type="v" direction="in"/><arg type="u" direction="in"/></method>
<method name="EventGroup"><arg type="a(isvu)" direction="in"/><arg type="ai" direction="out"/></method>
<method name="AboutToShow"><arg type="i" direction="in"/><arg type="b" direction="out"/></method>
<method name="AboutToShowGroup"><arg type="ai" direction="in"/><arg type="ai" direction="out"/><arg type="ai" direction="out"/></method>
<signal name="ItemsPropertiesUpdated"><arg type="a(ia{sv})"/><arg type="a(ias)"/></signal>
<signal name="LayoutUpdated"><arg type="u"/><arg type="i"/></signal>
<signal name="ItemActivationRequested"><arg type="i"/><arg type="u"/></signal>
</interface></node>"""

SNI_PATH, MENU_PATH = "/StatusNotifierItem", "/MenuBar"


@dataclass
class Item:
    label: str = ""
    action: Callable[[], None] | None = None
    enabled: bool = True
    separator: bool = False
    check: bool | None = None  # None: plain item; True/False: checkmark state
    id: int = field(default=0)

    def props(self) -> dict:
        if self.separator:
            return {"type": GLib.Variant("s", "separator")}
        p = {"label": GLib.Variant("s", self.label), "enabled": GLib.Variant("b", self.enabled),
             "visible": GLib.Variant("b", True)}
        if self.check is not None:
            p["toggle-type"] = GLib.Variant("s", "checkmark")
            p["toggle-state"] = GLib.Variant("i", 1 if self.check else 0)
        return p


def layout_variant(items: list[Item]) -> GLib.Variant:
    children = [GLib.Variant("(ia{sv}av)", (i.id, i.props(), [])) for i in items]
    return GLib.Variant("(ia{sv}av)", (0, {"children-display": GLib.Variant("s", "submenu")}, children))


class Tray:
    def __init__(self, title: str, icon_name: str, icon_theme_path: str, on_activate: Callable[[], None]):
        self.title, self.icon_name, self.icon_theme_path = title, icon_name, icon_theme_path
        self.tooltip = title
        self.on_activate = on_activate
        self.items: list[Item] = []
        self.revision = 1
        self.registered = False
        self.bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        sni = Gio.DBusNodeInfo.new_for_xml(SNI_XML).interfaces[0]
        menu = Gio.DBusNodeInfo.new_for_xml(MENU_XML).interfaces[0]
        self._ids = [self.bus.register_object(SNI_PATH, sni, self._sni_call, self._sni_get, None),
                     self.bus.register_object(MENU_PATH, menu, self._menu_call, self._menu_get, None)]
        self.name = f"org.kde.StatusNotifierItem-{os.getpid()}-1"
        self._own = Gio.bus_own_name_on_connection(self.bus, self.name, Gio.BusNameOwnerFlags.NONE, None, None)
        self._watch = Gio.bus_watch_name_on_connection(
            self.bus, "org.kde.StatusNotifierWatcher", Gio.BusNameWatcherFlags.NONE, self._watcher_up, None)

    # -- public
    def set_menu(self, items: list[Item]) -> None:
        for n, item in enumerate(items, start=1):
            item.id = n
        self.items = items
        self.revision += 1
        self.bus.emit_signal(None, MENU_PATH, "com.canonical.dbusmenu", "LayoutUpdated",
                             GLib.Variant("(ui)", (self.revision, 0)))

    def set_tooltip(self, text: str) -> None:
        if text != self.tooltip:
            self.tooltip = text
            self.bus.emit_signal(None, SNI_PATH, "org.kde.StatusNotifierItem", "NewToolTip", None)

    def close(self) -> None:
        Gio.bus_unwatch_name(self._watch)
        Gio.bus_unown_name(self._own)
        for i in self._ids:
            self.bus.unregister_object(i)

    # -- watcher
    def _watcher_up(self, conn, name, owner):
        conn.call("org.kde.StatusNotifierWatcher", "/StatusNotifierWatcher", "org.kde.StatusNotifierWatcher",
                  "RegisterStatusNotifierItem", GLib.Variant("(s)", (self.name,)), None,
                  Gio.DBusCallFlags.NONE, -1, None, self._registered)

    def _registered(self, conn, result):
        try:
            conn.call_finish(result)
            self.registered = True
        except GLib.Error:
            self.registered = False

    # -- StatusNotifierItem
    def _sni_get(self, conn, sender, path, iface, prop):
        return {
            "Category": GLib.Variant("s", "ApplicationStatus"), "Id": GLib.Variant("s", "packageflow"),
            "Title": GLib.Variant("s", self.title), "Status": GLib.Variant("s", "Active"),
            "WindowId": GLib.Variant("i", 0), "IconName": GLib.Variant("s", self.icon_name),
            "IconThemePath": GLib.Variant("s", self.icon_theme_path),
            "AttentionIconName": GLib.Variant("s", ""), "OverlayIconName": GLib.Variant("s", ""),
            "ToolTip": GLib.Variant("(sa(iiay)ss)", (self.icon_name, [], self.title, self.tooltip)),
            "ItemIsMenu": GLib.Variant("b", False), "Menu": GLib.Variant("o", MENU_PATH),
        }.get(prop)

    def _sni_call(self, conn, sender, path, iface, method, params, inv):
        if method in ("Activate", "SecondaryActivate"):
            GLib.idle_add(self.on_activate)
        inv.return_value(None)

    # -- dbusmenu
    def _menu_get(self, conn, sender, path, iface, prop):
        return {"Version": GLib.Variant("u", 3), "TextDirection": GLib.Variant("s", "ltr"),
                "Status": GLib.Variant("s", "normal"),
                "IconThemePath": GLib.Variant("as", [self.icon_theme_path])}.get(prop)

    def _find(self, item_id: int) -> Item | None:
        return next((i for i in self.items if i.id == item_id), None)

    def _menu_call(self, conn, sender, path, iface, method, params, inv):
        args = params.unpack()
        if method == "GetLayout":
            inv.return_value(GLib.Variant.new_tuple(GLib.Variant("u", self.revision), layout_variant(self.items)))
        elif method == "GetGroupProperties":
            ids = args[0] or [i.id for i in self.items]
            rows = [(i.id, i.props()) for i in self.items if i.id in ids]
            inv.return_value(GLib.Variant("(a(ia{sv}))", (rows,)))
        elif method == "GetProperty":
            item = self._find(args[0])
            value = item.props().get(args[1]) if item else None
            inv.return_value(GLib.Variant("(v)", (value or GLib.Variant("s", ""),)))
        elif method == "Event":
            self._event(args[0], args[1])
            inv.return_value(None)
        elif method == "EventGroup":
            for item_id, event, _data, _ts in args[0]:
                self._event(item_id, event)
            inv.return_value(GLib.Variant("(ai)", ([],)))
        elif method == "AboutToShow":
            inv.return_value(GLib.Variant("(b)", (False,)))
        elif method == "AboutToShowGroup":
            inv.return_value(GLib.Variant("(aiai)", ([], [])))
        else:
            inv.return_value(None)

    def _event(self, item_id: int, event: str) -> None:
        item = self._find(item_id)
        if event == "clicked" and item and item.action and item.enabled:
            GLib.idle_add(item.action)
