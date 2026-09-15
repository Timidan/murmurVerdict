# Murmur coming-soon waitlist

This is a standalone service for `murmurapp.live`. It serves only the files in `public/` and stores subscriber addresses in SQLite; it has no connection to the main Murmur application and sends no email.

The page reuses Murmur's dark and paper colors, the existing M waveform geometry, and self-hosted Doto, Space Grotesk, and Space Mono fonts. Font licenses are included in `public/fonts/`.

`GET /api/waitlist/count` returns only `{ "count": number }`, with caching disabled. The page reads the saved subscriber total on load and after a successful signup. Duplicate emails count once; if the count cannot load, the page says it is unavailable.

## Run locally

Node 22.13 or later is required (`node:sqlite` is built in). From this directory:

```sh
HOST=127.0.0.1 PORT=3187 PUBLIC_ORIGIN=http://127.0.0.1:3187 node server.mjs
```

The default database is `data/waitlist.sqlite`. To use another durable location, set `WAITLIST_DB` to an absolute path. In local development with no `PUBLIC_ORIGIN`, a supplied `Origin` must match the request host.

Run the focused smoke check with:

```sh
npm test
```

## Container

Create a `.env` file only on the deployment host if the default domain needs changing:

```env
PUBLIC_ORIGIN=https://murmurapp.live
```

Then start the isolated service:

```sh
docker compose up -d --build
curl http://127.0.0.1:3187/healthz
```

The compose file publishes only `127.0.0.1:3187`, creates the named `murmur-waitlist-data` Docker volume, and joins the existing external Docker network `public_proxy` as `murmur-waitlist`. On the intended host, that network is already used by Caddy; it must exist before `docker compose up` runs. Caddy can forward to `murmur-waitlist:3187` on that network. The supplied Compose configuration sets `TRUST_PROXY=1` for this Caddy arrangement. It trusts exactly one `X-Forwarded-For` value only when the direct peer is private or loopback. Standalone local runs leave proxy trust disabled by default.

Caddy reaches the service over `public_proxy`, not through the host loopback port. Once the domain points to the server, add the following site block to the existing Caddy configuration and validate before reloading:

```caddy
murmurapp.live {
    encode zstd gzip
    reverse_proxy murmur-waitlist:3187
}
```

DNS: the apex A record (`@`) must point to the chosen VPS. Inspect existing records before replacing the parking record; preserve mail records. Caddy obtains HTTPS certificates once DNS resolves to the host. Deployment and DNS changes must follow the workspace authorization rules.

## Export and backup

Run these from this directory. They use Node's built-in SQLite support, so no `sqlite3` shell is needed. Replace the mounted path if your deployment uses a different database location.

Export a CSV (the command prints only email addresses and timestamps, and prefixes spreadsheet-formula-looking values so opening it cannot execute a subscriber-controlled formula):

```sh
docker compose exec -T waitlist node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const safe = v => /^[=+\\-@]/.test(String(v)) ? '\'' + String(v) : String(v); const db = new DatabaseSync('/app/data/waitlist.sqlite'); console.log('email,created_at'); for (const row of db.prepare('SELECT email, created_at FROM waitlist_subscribers ORDER BY created_at').iterate()) console.log([row.email, row.created_at].map(v => '\"' + safe(v).replaceAll('\"', '\"\"') + '\"').join(',')); db.close();" > waitlist-export.csv
```

Make a consistent SQLite backup with SQLite's `VACUUM INTO`, which includes committed WAL data rather than copying the main database file alone:

```sh
docker compose exec -T waitlist node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/app/data/waitlist.sqlite'); db.exec(\"VACUUM INTO '/app/data/waitlist-backup.sqlite'\"); db.close();"
docker compose cp waitlist:/app/data/waitlist-backup.sqlite ./waitlist-backup.sqlite
```

Treat exported CSVs and backups as sensitive subscriber data. Keep them outside the public directory and transfer/store them only through the approved backup path.

## Deployed snapshot — 2026-09-06

`https://murmurapp.live` is live with trusted Let's Encrypt TLS and returns HTTP 200; `https://murmurapp.live/healthz` returns `{"ok":true}`. The apex DNS A record is `37.114.41.229` (TTL 300) on all four Name.com authoritative nameservers.

The current release is at `/home/agentops/murmur-waitlist/releases/20260906-waitlist-count` on the host; all 22 packaged release files were hash-verified before deployment. It runs as Compose project `murmur-waitlist`, service `waitlist`, container `murmur-waitlist`, using volume `murmur-waitlist-data`; image digest: `sha256:1eca953ae386c8345f956941684e42aeb95dd41fa30b311161148e230349945d`. The previous release remains at `/home/agentops/murmur-waitlist/releases/20260906-coming-soon`, with its image tagged `murmur-waitlist-waitlist:before-count-20260906`. A consistent database backup was saved in the mounted data volume at `/app/data/before-public-count-20260906.sqlite` before the update.

Caddy forwards only this host to `murmur-waitlist:3187`; its pre-change copy is `Caddyfile.before-murmur` in the original coming-soon release directory. The existing main application was not deployed or changed.

Useful host checks:

```sh
cd /home/agentops/murmur-waitlist/releases/20260906-waitlist-count
docker compose ps
curl -fsS https://murmurapp.live/healthz
curl -fsS https://murmurapp.live/api/waitlist/count
docker compose exec -T waitlist node --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; const db = new DatabaseSync('/app/data/waitlist.sqlite'); console.log(db.prepare('SELECT count(*) AS subscribers FROM waitlist_subscribers').get()); db.close();"
```

Verified the public form in a browser, confirmed its signup in the production database, and removed only that test entry. Local checks also covered duplicate submissions, invalid input, restart persistence, and retry after a server error. Desktop, mobile, dark, and paper layouts were inspected.

After deploying the public counter, the API, production database, and desktop/mobile browser all showed 1 subscriber. The existing subscriber was preserved. The focused smoke test verified initial count, unique signup, duplicate signup, and invalid input; a local browser signup also updated the displayed count without a reload.

The service collects subscriptions only; no email was sent as part of this deployment.

## Social preview deployment — 2026-09-07

The owner selected paper design C. The homepage now references
`https://murmurapp.live/brand/murmur-waitlist-paper-v1.png` in both Open Graph
and Twitter metadata, with image dimensions and alt text. The source artboards
and alternatives are kept outside the repository.

The current release is `/home/agentops/murmur-waitlist/releases/20260907-social-preview`,
image `sha256:6165525b25928a7170a01335d6cff3a25092ecd4e1990eadc5cad5e9af33d666`.
The previous image is retained as
`murmur-waitlist-waitlist:before-social-preview-20260907`. The server code,
signup script, styles, Compose configuration, and persistent data volume were
unchanged. All 23 packaged files passed checksum verification before deployment.

Public verification using `Twitterbot/1.0` returned HTTP 200 for the homepage
and PNG, correct preview metadata, and a 1200×630 PNG identical to the approved
export (SHA-256 `b72f4496cf2ab63cf8080c6d269b368c5eae8344fca352972b70fae782609863`).
Health returned `{"ok":true}` and the subscriber count remained 2 before and
after deployment. This verifies crawler access; an actual X post preview was
not observed.
