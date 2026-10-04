# signs backups

`ops/backup-signs` runs nightly at 03:30 from djperron's crontab (log:
`/tmp/backup-signs.log`) and writes to the NAS share
`/mnt/archive/backups/signs/`. Each part is independent; files are checked
before they get their final name, so a failed run never leaves a truncated
backup that looks complete. Run it by hand any time: `ops/backup-signs`.

| Folder | What | Kept |
|---|---|---|
| `mongo/` | `mongodump --archive --gzip` of the shared MongoDB (all app databases) | 14 days |
| `bet-tracker/` | bet-tracker SQLite, online backup + integrity check | 30 days |
| `home-assistant/` | HA config incl. `.storage`, secrets, custom components; Mosquitto; ring-mqtt. Not the recorder history DB or logs | 14 days |
| `pihole/` | `etc-pihole` settings, lists, certs, `compose.yaml`, `Corefile`. Not the query log | 14 days |
| `arr/` | Sonarr/Radarr's own weekly backup zips (newest 8 each); SABnzbd + SMA settings | 14 days |
| `stacks/` | Every stack under `~/docker-compose`: compose files, `.env` secrets, configs (no app data, `node_modules`, `.git`) | 30 days |
| `system/` | Apache config, djperron's crontab | 30 days |

Not covered: `/etc/letsencrypt` (root-only; re-issue with certbot), the
`thunderdome-*` media volumes (already on the NAS), and `~/repos` projects.

## Restore

- **Mongo:** `docker exec -i webhook-docker-mongodb-1 sh -c 'mongorestore --archive --gzip --drop -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin' < mongo-DATE.archive.gz`
  (add `--nsInclude 'calcium.*'` to restore one app).
- **bet-tracker:** stop the container, copy the `.sqlite` over
  `/data/bet-tracker.sqlite` in the `bet-tracker-data` volume (e.g.
  `docker run --rm -v webhook-docker_bet-tracker-data:/data -v $PWD:/b alpine cp /b/bet-tracker-DATE.sqlite /data/bet-tracker.sqlite`), start it.
- **Home Assistant / Pi-hole:** stop the stack, `tar xzf` the archive inside
  its stack directory (as root, since the containers write as root), start it.
- **Sonarr / Radarr:** System → Backup → Restore in each app, using the zip.
- **Stacks / system:** extract and copy back the files you need.
