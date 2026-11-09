# Deployment guide

## 1. Recommended topology

| Component | Responsibility |
| --- | --- |
| DigitalOcean Ubuntu LTS Droplet | Persistent Linux host, Docker and local volume |
| Coolify | Builds, environment secrets, service lifecycle, HTTPS routing and logs |
| Bot container | One Node 24 process and one managed Chromium/WhatsApp session |
| `bot-data:/data` | WhatsApp authentication profile, SQLite queues and saved outbox |
| Cloudflare | DNS/HTTPS proxy or optional Tunnel + Access protecting the operator page |

Suggested starting host: 2 vCPU, 4 GB RAM, sufficient SSD space for browser profiles/builds/backups. Monitor memory during image builds and summary processing; resize based on actual load. This is not a guarantee of a particular group count or throughput.

Cloudflare Workers/Pages are not a direct hosting target for this full-browser process. Cloudflare Containers supports Docker workloads but has ephemeral disk by default; a native deployment needs separate session/database persistence and lifecycle engineering. This package uses Cloudflare as the edge/access layer with the bot on the VPS.

## 2. Prepare DigitalOcean and Coolify

1. Create a fresh Ubuntu LTS Droplet with SSH key authentication and suitable capacity. Install Coolify following its current official installation guide.
2. Create the Coolify admin account promptly, set a strong password and protect its management interface. Keep its installation secrets backed up separately.
3. Apply firewall rules suitable for the chosen routing method. For normal Coolify HTTPS routing allow application HTTP/HTTPS, and restrict SSH/management ports to trusted sources. Do not expose container port 3000 directly to the public internet.
4. Create a Coolify project and a Production environment. Use a different WhatsApp account and volume for development/testing.
5. Add this repository/branch as a Docker Compose application. Base Directory `/`; Docker Compose Location `/compose.yaml`. Alternatively use Docker Compose Empty and paste the Compose definition, but a local build needs source code present; the Git-based application is simpler here.

## 3. Configure the bot

Use runtime environment variables, never Docker build arguments, for secrets:

| Variable | Value |
| --- | --- |
| `GEMINI_API_KEY` | Your Gemini Developer API project key |
| `ADMIN_TOKEN` | Generate 32 random bytes, e.g. `npm run token`; paste the resulting hex string |
| `GEMINI_MODEL` | A currently available model for this key/project |
| `ALLOWED_GROUP_IDS` | Leave blank during pairing |
| `ALLOWED_SENDER_IDS` | Optional exact IDs of operators; linked-account commands already work |
| `ALLOW_MEMBER_COMMANDS` | Keep `false` unless all members should be allowed to trigger AI calls |

Confirm the `bot-data` volume destination is `/data`. The Compose service uses UID/GID 1000. Named volumes inherit the image's `/data` ownership. If you replace this with a host bind mount, pre-create that directory and set owner 1000:1000, mode 700, before deployment. Do not put the volume on NFS or object-storage FUSE; it contains SQLite WAL and a browser profile.

One replica only. Use stop-then-start redeploys, not a rolling overlap. The entrypoint holds an exclusive `flock` on `/data/instance.lock`: a second container sharing that volume exits with code 75 rather than opening the same browser profile. If a rolling deployment stalls on this lock, stop the old container before starting the replacement. Do not create a second independent volume for the same account just to bypass the lock. A short reconnection interruption is expected on deployment.

Use `/healthz` for container/Coolify health. It stays healthy during QR pairing and reconnection while the service/database are available. Use `/readyz` for a separate connectivity monitor; it returns 503 until WhatsApp is ready. Readiness does not validate Gemini quota; run `check:gemini` separately.

## 4. Choose Cloudflare routing

### Option A: DNS + Coolify HTTPS

1. Add a DNS record for an operator hostname such as `digest.example.com` pointing to the Droplet.
2. In Coolify, assign `https://digest.example.com:3000` to the `bot` service. The `:3000` identifies the internal service port; public traffic still uses normal HTTPS.
3. Establish a valid origin certificate. Use Cloudflare SSL/TLS **Full (strict)** when enabling the proxy. Follow the certificate challenge method appropriate for the host.
4. Create a Cloudflare Access application/policy for this hostname restricted to your operators. The application token remains required after Access login.
5. Add a cache bypass rule for the entire operator hostname; the app also emits `Cache-Control: no-store`.

### Option B: Cloudflare Tunnel + Access

This avoids public inbound application ports; it still runs the bot on the DigitalOcean/Coolify server.

1. Create a remotely managed Cloudflare Tunnel and obtain its connector token.
2. Deploy `compose.yaml` together with `compose.cloudflare.yaml`, or add the overlay's `tunnel` service to the same Coolify Compose stack. Both services must share the Compose network.
3. Set `CLOUDFLARE_TUNNEL_TOKEN` as a runtime secret. The overlay passes it as an environment variable, not a command-line argument.
4. In the tunnel's public-hostname configuration, set the hostname's service to **`http://bot:3000`**.
5. Configure a Cloudflare Access policy for the hostname. No public domain assignment on the bot's Coolify proxy is needed with this option.
6. Keep SSH/Coolify administration reachable only through your chosen secured management path. Do not close management access until you have verified the alternative path.

The overlay pins `cloudflare/cloudflared:2026.10.0`; keep it updated after reviewing/testing newer official releases. Cloudflare Tunnel protects inbound operator traffic. WhatsApp and Gemini outbound traffic still goes directly from the VPS; the tunnel does not move the bot's execution into Cloudflare.

## 5. Pair and enable groups

1. Deploy, open the HTTPS operator page and enter `ADMIN_TOKEN`.
2. In the WhatsApp app for the intended account, open Linked devices and scan the current QR. The QR is available only through authenticated API requests and expires from the UI after a short interval.
3. Wait for the page to show **ready**. Click **List WhatsApp groups**.
4. Copy exact group IDs into `ALLOWED_GROUP_IDS`, separated by commas. No wildcard is accepted. Inform the participating groups about collection and Gemini processing.
5. Redeploy while keeping the volume. New messages in only those groups are recorded.
6. Send a normal text message and `!summarize` from the linked account. Direct messages do not trigger summaries. To permit another member, configure their exact `@c.us` or `@lid` sender ID; those IDs are included in source citations, or can be obtained from your known WhatsApp integration data. Do not assume every LID equals a phone number.

## 6. Acceptance checks on the actual host

- `node scripts/check-gemini.js` inside the container succeeds using its runtime environment. It makes one small test request.
- Two enabled groups produce separate summaries, with no messages from the other group.
- A group not listed in configuration is not recorded; private chats are ignored.
- A member not configured as an operator cannot trigger AI calls.
- A message arriving during generation remains in the next pending batch.
- Restart and then redeploy preserve the login and the queued messages.
- Remove outbound connectivity temporarily during a test summary; restoring it and issuing the command after the cooldown should complete the saved work without losing the snapshot. Do this only in a test environment.
- Without the token, `/api/status`, `/api/qr` and `/api/groups` return 401. Health endpoints reveal only booleans.
- Cloudflare Access and TLS work from an external browser, and the origin is not unintentionally reachable around your access policy.

## 7. Back up and restore

The volume is durable across container recreation; it is not a backup. Schedule encrypted, off-server backups appropriate for the sensitivity of chat/session data.

For a full backup, **stop the bot before archiving the entire `/data` volume**. Include the database, its WAL/SHM files if present and the browser auth profile together. If using Coolify storage backups, choose the stop-container/quiesced backup option. Do not merely copy the main `.sqlite` file while writes are active. Keep Coolify configuration/secrets backed up separately.

Restore with all bot instances stopped. Restore the full data directory to the same mounted volume, set owner UID/GID 1000 and directory mode 700, then start one instance. Test restoration on an isolated host without simultaneously connecting the same account from the original instance. Pair again if WhatsApp has revoked the linked session.

To remove a group's stored queue, saved snapshot and deduplication entries:

```sh
# Stop the service first. Run this through a one-off container using the same volume.
docker compose stop bot
docker compose run --rm bot node scripts/purge-group.js 123456789@g.us
docker compose up -d bot
```

Also remove the group from `ALLOWED_GROUP_IDS` if collection should stop. Existing backups may still contain its data. The purge command refuses while another container holds the volume lock. Never use `docker compose down -v` for normal redeployment: it removes persistent volumes.

## 8. Troubleshooting

| Symptom | Check |
| --- | --- |
| Container exits immediately | Required runtime secrets; Node 24; `/data` ownership; existing instance lock |
| Exit code 75 | Another instance holds the same data volume; stop it before replacing |
| Ready never appears | QR pairing; outbound DNS/HTTPS; Chromium dependencies; account session state |
| QR needed after each deploy | Volume mount changed, was deleted, or does not cover `/data/auth` |
| Group command does nothing | Exact allowed group ID; operator ID; linked-account command versus private chat |
| Summary failed / unavailable model | Run `check:gemini`; verify key, model entitlement, billing/quota and outbound access |
| Retry resumes old output | Expected: an unfinished outbox is completed before a new batch starts |
| Group list unavailable | WhatsApp must be ready; upstream WhatsApp Web compatibility may require a library update |
| Login lost after logout | Re-pair through the UI; do not restore a revoked session as a way to bypass revocation |

Logs intentionally omit provider error bodies, chat bodies and secrets. Event names distinguish generation, delivery, startup and connectivity failures. A repeated upstream compatibility failure may require a reviewed update to `whatsapp-web.js`; local safeguards cannot guarantee compatibility with every future WhatsApp change.

## Official references checked

- [Coolify Docker Compose](https://coolify.io/docs/applications/builds/docker-compose)
- [Coolify persistent storage](https://coolify.io/docs/applications/configuration/persistent-storage)
- [Coolify rolling updates](https://coolify.io/docs/applications/deployments/rolling-updates)
- [Coolify installation](https://coolify.io/docs/start-with-self-hosted)
- [Cloudflare Containers FAQ](https://developers.cloudflare.com/containers/faq/)
- [Cloudflare Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/)
- [WhatsApp Web.js authentication](https://wwebjs.dev/guide/creating-your-bot/authentication)
- [Gemini model availability](https://ai.google.dev/gemini-api/docs/models)
