# WhatsApp Group Digest

A single-account WhatsApp group assistant that extracts action items, approval mentions and event announcements using Gemini. It includes a protected browser-based pairing/status page and persistent per-group queues.

## Hosting recommendation

**DigitalOcean Droplet → Coolify → this Docker Compose application. Cloudflare supplies DNS/HTTPS or an optional Tunnel + Access layer.**

- Start with an Ubuntu LTS server with **2 vCPU and 4 GB RAM** for Coolify, Chromium and image builds. This is a starting recommendation, not a measured capacity guarantee.
- Deploy **one bot replica**, on one server, with a persistent local volume mounted at **`/data`**. Keep this volume when redeploying.
- Workers/Pages cannot run this repository unchanged: it needs a full Node runtime, a continuously connected Chromium process and a durable local browser profile. Cloudflare Containers also needs a different persistence/lifecycle design; its disk is ephemeral by default. The included Cloudflare integration is a Tunnel to the DigitalOcean/Coolify host, not a claim of native Workers deployment.
- No public web endpoint is needed for WhatsApp itself. The HTTP service is only for operator pairing/status and health checks.

Detailed instructions: [Coolify, DigitalOcean and Cloudflare deployment](docs/DEPLOYMENT.md).

## Changes in version 2

- SQLite queues keyed by group ID; no cross-group prompts or clearing.
- Fixed snapshots, persistent multipart outbox and per-chunk delivery progress. Messages arriving during generation remain queued.
- A group processing lock, global concurrency bound, cooldown, operator restrictions and message replay deduplication.
- Only explicit allowed groups are recorded. An empty allowlist starts in setup mode and records no chats.
- Supported linked-account commands through `message_create`; reserved output prefix prevents feedback loops.
- Configurable Gemini model, bounded request duration/retries, structured extraction and source-quote validation. Empty/blocked/truncated output never consumes the snapshot.
- Missing configuration fails startup; `.env` is loaded for local runs. Secrets, auth profiles and message databases are excluded from git/image context.
- Non-root Node 24 + Debian Chromium container, pinned npm lockfile, persistent storage, shutdown handling, reconnect backoff, browser checks and an OS-level singleton lock in the container.
- Puppeteer is explicitly overridden to 25.16.0 to remove vulnerable browser dependency paths. `.npmrc` omits unused optional RemoteAuth/archive dependencies; this application supports LocalAuth with a persistent volume. Keep the override reviewed alongside WhatsApp Web.js updates and run the host smoke/acceptance checks.
- Token-protected pairing/status UI. `/healthz` is liveness; `/readyz` is WhatsApp connection readiness. Pairing does not make a deployment fail liveness checks.
- Automated regression tests and CI image/browser checks.

## First deployment in Coolify

1. Put this source in a branch of your repository. Use the provided package instructions if you received a ZIP.
2. In Coolify, add the repository as a **Docker Compose application**. Base directory `/`, Compose file `/compose.yaml`. This also works on a non-DigitalOcean Linux VPS.
3. Set runtime `GEMINI_API_KEY` and a strong `ADMIN_TOKEN` (generate with `npm run token`). Keep `ALLOWED_GROUP_IDS` empty initially. Choose `GEMINI_MODEL` enabled for your Gemini project; default is `gemini-3.5-flash-lite`.
4. Confirm the persistent `bot-data` volume is mounted at `/data`, set one replica, and use **stop then start** deployments. Do not enable concurrent preview deployments against the same WhatsApp account/volume.
5. Assign an HTTPS domain to the `bot` service, internal port **3000**, or use the optional Cloudflare Tunnel. Keep the admin page behind Cloudflare Access where possible.
6. Deploy, open the page, enter the admin token and scan the QR in WhatsApp's Linked devices screen.
7. Click **List WhatsApp groups**, copy the required IDs into `ALLOWED_GROUP_IDS` as a comma-separated list, and redeploy without removing the volume. Tell those groups how their messages are processed.
8. Send a few new text messages in an enabled test group. From the linked account send `!summarize`. To let another operator trigger it, add their exact WhatsApp sender ID to `ALLOWED_SENDER_IDS`. `@lid` IDs may differ from phone-number IDs.
9. Restart/redeploy and verify that no new QR scan is needed and pending messages remain. Test both a second group and a failed summary retry before wider use.

## Local development

Requires Node **24+** and Chromium/Chrome. The container is the preferred reproducible setup.

```sh
npm ci
cp .env.example .env
npm run token
```

Edit `.env`: set `GEMINI_API_KEY`, paste the generated token as `ADMIN_TOKEN` and set `PUPPETEER_EXECUTABLE_PATH` if using system Chromium. With a normal non-root local browser, keep the sandbox enabled. `npm ci` can download Puppeteer's default browser; skip that download with `PUPPETEER_SKIP_DOWNLOAD=true` if using system Chromium instead.

```sh
npm run check
npm test
npm run check:gemini
npm start
```

Visit `http://localhost:3000` locally. Use HTTPS or an SSH tunnel on a remote host; never enter the admin token over public plain HTTP. `check:gemini` makes one small billable test request without submitting chat content.

For a local Docker run:

```sh
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

The Docker stack binds the local override to `127.0.0.1` only. The container's data directory is always `/data`, regardless of local `.env`'s `DATA_DIR`.

## Pairing and recovery

This deployment links **one WhatsApp account**. QR codes rotate automatically while pairing is pending; no QR is shown for an already paired, connected account. **Refresh pairing QR** restarts an unpaired browser to obtain a fresh code. **Reconnect WhatsApp** restarts the browser using the saved pairing without logging out or deleting the profile. Groups can be listed only when Connection says **ready**. If a reconnect fails, inspect the runtime logs and restart the application in Coolify without removing `/data`.

For several phone numbers in version one, deploy a separate Coolify application for each number, with its own domain, admin token, persistent volume, and allowed group IDs. Never share `/data` or the browser profile between numbers. Adding another number is a separate deployment, not another QR scan into this instance. To replace an account, use a fresh instance/volume; retain the original volume for recovery rather than deleting it. Provision server capacity for the additional browsers before expanding.

## Commands and collection scope

Digests use WhatsApp bold headings, concise action/event/approval sections, local dates and readable part numbers. Technical message IDs, sender addresses and job IDs stay out of generated digest metadata. `TIME_ZONE` defaults to `Africa/Lagos`; set a valid IANA timezone for your audience. Short source quotes are optional with `DIGEST_INCLUDE_SOURCES=true`; exact source-quote validation always runs, including when quotes are hidden. Explicit identifiers supplied as ordinary conversation content are not universally removed. Existing saved outbox chunks retain their original presentation until delivered.

The dashboard's **Message processing** section shows received/stored messages, received commands, rejection reasons and the current summary stage for each enabled group since startup. A `ready` connection alone does not prove ingestion or delivery. Message identities accept current WhatsApp MsgKeys without `_serialized`; deterministic IDs preserve replay deduplication. Before sending, a compatibility adapter restores the missing MsgKey alias using WhatsApp's own canonical serializer. Send results must include a message identifier before the outbox advances.

`npm run check:gemini` tests the actual structured extraction request and validates source quotes using synthetic text. A plain greeting prompt cannot detect schema incompatibilities. Nested array counts are enforced by application validation rather than provider schema bounds, which the configured model rejected with HTTP 400.

- `!summarize` extracts the **oldest pending batch** (up to 200 messages / 60,000 JSON characters by default). Repeat after the cooldown to process the next batch.
- `!help` describes command usage. Leading/trailing spaces and command case are ignored.
- Commands are accepted from the linked account and configured operators. `ALLOW_MEMBER_COMMANDS=true` explicitly permits every member of enabled groups to request summaries.
- Direct messages and unlisted groups are ignored. Bot output and command messages are excluded from summaries. Ordinary messages from the linked account are recorded by default; `RECORD_OWN_MESSAGES=false` disables that recording while retaining its commands.
- The bot processes newly received events while connected. It does **not** fetch a group's entire history or guarantee recovery of everything sent during downtime. WhatsApp may replay some events; deduplication prevents recent repeats from being reprocessed.
- Text only: media messages are represented as excluded non-text entries. Images, documents and audio are not downloaded/transcribed; the summary discloses excluded media and shortened text. Add multimodal processing as a separate feature after controlling file limits and costs.

## Storage, retries and truthful delivery guarantees

`/data` holds `messages.sqlite` (SQLite WAL), the WhatsApp profile under `auth/`, browser version cache and singleton lock file. Restrict access and back it up as described in the deployment guide.

Messages are retained for seven days and capped at 5,000 pending messages per group by default. Retention/cap omissions are counted and disclosed. Messages longer than 4,000 characters are shortened with a coverage notice. Batches are FIFO; they no longer discard the backlog just because 200 messages have arrived.

Before contacting Gemini, the selected snapshot is saved. Generated output is saved before sending; each successful chunk is acknowledged separately. Retrying `!summarize` resumes the saved job. Retries after a restart are **operator-triggered**, not automatic mass resends. Successfully delivered snapshots are removed; messages arriving later remain queued.

There is an unavoidable ambiguity if WhatsApp accepts a send and the process dies before SQLite records its acknowledgement. A retry may duplicate that one chunk. Job IDs remain internal in storage/logs; multipart digests show readable part numbers. This is **at-least-once recovery, not exactly-once WhatsApp delivery**. Gemini generation can also be repeated if interrupted before its response was saved.

An unfinished summary retains its snapshot beyond normal message retention until completed or explicitly purged. To remove a group's stored data, stop the bot and run the documented purge command. Disk deletion is logical deletion, not secure erasure of SSDs/backups.

## Configuration

See [.env.example](.env.example) for every setting. Main settings:

| Setting | Default / meaning |
| --- | --- |
| `GEMINI_API_KEY`, `ADMIN_TOKEN` | Required runtime secrets; token minimum 32 characters |
| `GEMINI_MODEL` | `gemini-3.5-flash-lite`; use a model enabled for the project |
| `ALLOWED_GROUP_IDS` | Empty = no collection. Exact IDs, maximum 100 groups |
| `ALLOWED_SENDER_IDS` | Comma-separated exact `@c.us` / `@lid` operator IDs |
| `ALLOW_MEMBER_COMMANDS` | `false` |
| `DATA_DIR` | `./data` locally; `/data` in Compose |
| `MAX_SUMMARY_MESSAGES` / `MAX_INPUT_CHARS` | `200` / `60000` per request |
| `MAX_PENDING_PER_GROUP` / `RETENTION_DAYS` | `5000` / `7` |
| `SUMMARY_COOLDOWN_SECONDS` | `60` per group, including failed attempts |
| `MAX_CONCURRENT_SUMMARIES` | `2` across all groups |
| `AI_TIMEOUT_SECONDS` | `90` per attempt; one application retry on 408/429/5xx |
| `QR_IN_TERMINAL` | `false`; use the protected pairing page |
| `CHROMIUM_NO_SANDBOX` | `false` locally, `true` in the constrained non-root Docker setup |

## Security and remaining platform limits

The UI token is sent as a Bearer header, held only in page memory and never put into URLs. The page has no third-party scripts; status/QR endpoints require authentication and disable caching. Logs exclude raw messages, keys, QR payloads and provider error bodies. Use strong random tokens, HTTPS and optionally Cloudflare Access. Anyone with admin access can obtain a WhatsApp pairing QR, so protect this page accordingly.

The Docker build disables Chromium's sandbox for container compatibility; it compensates with a non-root user, dropped capabilities and no-new-privileges. This is not equivalent to Chrome's sandbox. Keep the host/browser patched and isolate the service from unrelated secrets. Use encrypted backups and sensible access controls for the stored chats and session profile.

This remains an **unofficial WhatsApp Web client**. Upstream WhatsApp changes, account restrictions and platform blocking cannot be eliminated by this code. Do not use financial extraction as payment approval; quotes are checked against input, but that cannot prove the model's interpretation is correct. For business-critical messaging, assess the official WhatsApp Business Platform's current features against your group-reading requirements before redesigning.

## Validation

`npm test` runs isolated regression checks without a live WhatsApp session or Gemini key. `npm run smoke:browser` launches a real local Chromium browser against a stubbed operator UI. CI repeats tests, builds the container and checks its runtime. Passing these checks does not replace pairing, real model access, cloud storage and end-to-end group acceptance tests on the deployment host.

See [implementation validation](docs/VALIDATION.md) for the checks performed when this package was prepared.
