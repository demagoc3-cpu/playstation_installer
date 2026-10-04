# Torznab search

[← Contents](index.md) · [Русский](../ru/search.md)

WEB → Search uses a configured Torznab-compatible indexer. It is not a built-in global game catalog.

1. Configure an indexer you are entitled to use in Jackett or Prowlarr.
2. Copy its Torznab URL and API key. Example Jackett URL: `http://127.0.0.1:9117/api/v2.0/indexers/<indexer>/results/torznab/`; Prowlarr: `http://127.0.0.1:9696/<id>/api`.
3. In PackageFlow select Source, enter its name/URL/key and categories, then save. The default category is `1180` (PS4). Enter other categories as comma-separated numbers, or leave categories blank to search all platforms. Leaving the API key blank when updating settings retains the saved key.
4. Enter a query, Find, then Download a result. It is sent to qBittorrent, with the auto-install preference applied.

Results show sizes and seed counts, up to 40 items. Container `127.0.0.1` is the container itself; use an address reachable from the WEB server. The native PS4 search currently filters the WEB library; external source searching is planned.

The first tracker query may take longer than repeat queries: WEB waits up to 60 seconds. API key errors and invalid Torznab responses are reported as search errors instead of empty results.

## Result cards

Results appear as cards. Open a card to see its size, seeders and leechers, publication date, source, and full release title. Version, language and Backport labels are inferred from the title; they describe the author's release, not verified PKG metadata.

Opening a card loads the description and cover from its release page when the source provides a link. If the page requires sign-in or is unavailable, Torznab data remains visible. RuTracker requests can fall back to local FlareSolverr; configure its address with `PACKAGEFLOW_FLARESOLVERR_URL` (default `http://127.0.0.1:8191`).

Download sends the release to qBittorrent. Download and install also enables the existing PackageFlowService automatic PKG installation after completion. Opening a card never starts a download.
