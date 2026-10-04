# Installed games and system information

[← Contents](index.md) · [Русский](../ru/console.md)

WEB → On console reads actual installed applications, patches and DLC from PackageFlowService. It shows covers, versions and sizes.

- Launch or stop a game.
- Remove a patch, a DLC, all DLC or the complete game. Review the component list and confirm with the title ID.
- Reinstall from the WEB library after the previous game/components are removed successfully.

Removal uses the system uninstall APIs, not arbitrary deletion of game directories. Save data is preserved. A lost reply is checked using the previous operation ID; repeat commands are not sent blindly. An uncertain removal result stops a reinstall until resolved.

WEB → System information displays firmware, model, GoldHEN details, internal/external space, service version and uptime. It also provides service update/restart controls. See [updates and persistent data](updates-data.md).

The native PS4 On console screen is not connected to these controls yet; the game-card installation/presence features are separate.
