# Saved 029 startup when the closed service port times out

The observed Windows→PS5 LAN can time out on closed port 8095 after an owned
service shutdown. Timeout alone still does not prove the service is absent.

The browser startup path can qualify absence only with all of these:

- A previously verified PS5 profile on firmware 13.60.
- The current, independently hashed local 029 artifact (`6cfe3a48…01b735a`) and
  the matching saved canonical payload receipt.
- Fresh PLDMGR 0.6.1 metadata matching that receipt's path, slot, version and build.
- Two full, validated process inventories around the metadata recheck, containing
  the audited system processes and PLDMGR but no possible PackageFlow process.

The process proof validates unique numeric PIDs, names, finite memory values,
daemon flags, all expected system rows and one PLDMGR. Two `SceAIO` processes with
distinct PIDs are an observed system exception. Unknown names, generic payloads,
PackageFlow names, partial lists or malformed replies fail closed.

The proof applies only to a connection timeout before a usable HTTP response.
Received HTTP, malformed JSON, interrupted response-body reads and unreachable
network errors do not qualify. Normal responding services and the existing
explicit Windows confirmed-stop mechanism retain their prior behavior.

Status GET performs only reads. Explicit startup repeats the current artifact,
metadata, process and target/queue guards at the launch boundary, then uses the
existing durable intent and no-replay behavior. A process proof permits only the
known saved PLDMGR launch: a later unavailable or empty metadata snapshot cannot
switch that request to loader 9021 or registration. After selecting the ordinary
loader route, health checks cannot adopt a later process-proof fallback. PS4, independent device locks,
paired keys, queues and UI geometry are unchanged. Host fixtures cover the
observed inventory and races; this source change does not constitute deployment
or an additional hardware launch.
