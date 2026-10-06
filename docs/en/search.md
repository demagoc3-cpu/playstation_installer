# Torznab search

[← Contents](index.md) · [Русский](../ru/search.md)

WEB → Search uses a configured Torznab-compatible indexer. It is not a built-in global game catalog.

1. Configure an indexer you are entitled to use in Jackett or Prowlarr.
2. Copy its Torznab URL and API key. Example Jackett URL: `http://127.0.0.1:9117/api/v2.0/indexers/<indexer>/results/torznab/`; Prowlarr: `http://127.0.0.1:9696/<id>/api`.
3. In PackageFlow select Source, enter its name/URL/key and categories, then save. The default category is `1180` (PS4). Enter other categories as comma-separated numbers, or leave categories blank to search all platforms. Leaving the API key blank when updating settings retains the saved key.
4. Enter a query, Find, open a result card, then choose Download or Download and install. qBittorrent downloads the release; the second action enables automatic PKG installation through the PS4 service.

Results default to newest first. WEB requests pages of 50 releases; **Show more** appends the next page without duplicates. Sorting applies to all loaded results. When the source provides a total, it appears alongside the loaded count.

The number of available results depends on the indexer. Some adapters only fetch the tracker's first page: the tested Prowlarr RuTracker adapter does not request subsequent tracker pages. Increasing PackageFlow's `limit` cannot fix that adapter limitation. An empty or repeated response removes the next-page button.

Container `127.0.0.1` is the container itself; use an address reachable from the WEB server. The native PS4 search currently filters the WEB library; external source searching is planned.

The first tracker query may take longer than repeat queries: WEB waits up to 60 seconds. API key errors and invalid Torznab responses are reported as search errors instead of empty results.

## Result cards

Results appear as cards. Open a card to see its size, seeders and leechers, publication date, source, and full release title. Version, language and Backport labels are inferred from the title; they describe the author's release, not verified PKG metadata.

Descriptions and covers are prefetched for visible cards when the source provides a release page link. At most two requests run concurrently; opening a card reuses an ongoing request or ready data. If the page requires sign-in or is unavailable, Torznab data remains visible. Background loading and card hover use HTTP only. Opening a RuTracker card can use local FlareSolverr if HTTP is blocked; configure its address with `PACKAGEFLOW_FLARESOLVERR_URL` (default `http://127.0.0.1:8191`).

Download sends the release to qBittorrent. Download and install also enables the existing PackageFlowService automatic PKG installation after completion. Opening a card never starts a download.

## Description cache

Successful descriptions, author metadata and cover URLs are stored in `.data/search-details-cache/` for 24 hours and survive WEB restarts. Failed responses are not persisted. The cache is automatically cleaned and keeps approximately 1000 entries. Seeders, leechers and other release statistics are refreshed through Torznab on each new search.

These are HTTP page requests, without downloading torrent files. Verified page cookies and its User-Agent are reused for subsequent HTTP requests to the same origin and kept only in WEB memory for up to 15 minutes. Cookies never cross origins or enter the description cache. Chromium closes immediately once HTTP accepts the verification. If the source still requires a browser, its reusable session serializes requests and closes after five idle minutes. The first request for a new page may take longer than opening an already loaded card.
