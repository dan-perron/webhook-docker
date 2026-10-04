# Upgrading signs: Ubuntu 20.04 → 22.04 → 24.04

Written 2026-10-04 from a read-only survey of `signs`. Re-check the
"Current state" facts before starting; anything that changed since then
changes the plan.

## Current state

- Ubuntu 20.04.6, kernel 5.4.0-231 running, 5.4.0-241 installed but not booted.
- Ubuntu Pro (free personal): ESM infra/apps and Livepatch on, so 20.04 keeps
  security updates until **April 2030**. Unattended upgrades on. The release
  upgrade is for newer libraries, not security.
- `/` (including `/boot` and `/var/lib/docker`) is the LVM volume
  `ubuntu-vg/root`, 467 GB, 159 GB used. `/boot/efi` is a separate partition.
- Networking, all hand-built, all must survive each hop:
  - NetworkManager runs `eno1` and the VLAN sub-interface `eno1.60`
    (netplan only says "renderer: NetworkManager").
  - `macvlan-host.service` (custom systemd unit) adds `macvlan-host` on
    `eno1.60` with 10.1.1.1/16, so the host can reach its macvlan containers.
  - Pi-hole (10.1.1.22) and CoreDNS (10.1.1.21) run on a Docker macvlan
    network on `eno1.60`, not on host port 53. The host resolves through
    10.1.1.11 and 10.1.1.21. `systemd-resolved` has `DNSStubListener=no`.
- Services: Apache 2.4 (TLS for djperron.com via certbot from Ubuntu's repo),
  Docker CE 28 (Docker's repo), Plex (Plex's repo), Samba stopped, ufw on.
  Every running container has `restart: unless-stopped`.
- `ubuntu-desktop` is installed and it boots to `graphical.target`.
- Stale apt sources from 18.04 (nothing installed from the last two):
  certbot PPA (dead), `mongodb-org 4.2`, `nodesource node_12.x`.

## Phase 1: patch 20.04 and reboot (do this soon, independent of the rest)

About 10 minutes of downtime. Every service should come back on its own.

```bash
sudo apt update && sudo apt full-upgrade
sudo reboot
```

Then check that everything came back (see "Verify" below). After this the
server runs kernel 5.4.0-241.

## Phase 2: prepare for the release upgrade

Pick a quiet weekend morning. Each hop is about an hour plus reboots; Home
Assistant, Pi-hole/CoreDNS, Plex and all djperron.com apps are down
throughout.

1. **Fresh backup, plus what the nightly job can't read:**
   ```bash
   ~/docker-compose/webhook-docker/ops/backup-signs
   sudo tar czf /mnt/archive/backups/signs/system/root-extras-$(date +%F).tar.gz \
     /etc/letsencrypt /etc/NetworkManager/system-connections \
     /etc/systemd/system/macvlan-host.service /etc/systemd/resolved.conf \
     /etc/netplan /etc/fstab /etc/ufw /etc/samba \
     /root/.cifscreds-thunderdome /home/djperron/.cifscreds-thunderdome
   ```
   (The two `.cifscreds-thunderdome` files hold the NAS mount credentials
   referenced by `/etc/fstab`.)
2. **Check LVM space for a rollback snapshot:** `sudo vgs`. If `VFree` is
   50 GB or more, each hop gets a snapshot (Phase 3, step 1). If it's 0,
   there's no instant rollback: the backups above are the fallback, and it's
   worth considering whether that's acceptable.
3. **Remove the stale sources** (and the leftovers from the last upgrade):
   ```bash
   cd /etc/apt/sources.list.d
   sudo rm -f certbot-ubuntu-certbot-bionic.list* mongodb-org-4.2.list* nodesource.list* \
     plexmediaserver.list.distUpgrade plexmediaserver.list.dpkg-dist yarn.list.distUpgrade yarn.list.save
   sudo apt update      # must finish with no errors or warnings
   ```
4. **Settle Mosquitto and ring-mqtt first,** so the upgrade isn't blamed for
   them. Mosquitto (`home-assistant-mosquitto-1`) has been stopped since
   2026-01-07 and has no restart policy, so Home Assistant's MQTT
   integration has no broker; ring-mqtt can't log in (expired Ring token).
   Either revive them (add `restart: unless-stopped` to `mosquitto` in
   `home-assistant/docker-compose.yml`, `docker compose up -d`, regenerate the
   Ring token in ring-mqtt's web UI) or remove them and the HA integration.
5. **Keep the desktop for now.** `network-manager` is installed as a
   dependency of `ubuntu-desktop`; removing the desktop and running
   `apt autoremove` can uninstall NetworkManager and take the server off the
   network (VLAN and DNS included). Going headless is a separate project:
   move `eno1`/`eno1.60` to netplan + networkd first, then remove the desktop.
6. **Record a baseline** to compare after each hop:
   ```bash
   docker ps --format '{{.Names}} {{.Status}}' | sort > ~/pre-upgrade-docker.txt
   systemctl --failed > ~/pre-upgrade-failed.txt
   ip -br addr > ~/pre-upgrade-ip.txt
   ```
7. **Have a way in that doesn't need the network,** in case NetworkManager or
   the VLAN doesn't come back: a keyboard and monitor on `signs`.
8. **DNS during the upgrade:** clients that use 10.1.1.21/10.1.1.22 fall
   back to 10.1.1.11 if they have it as a secondary. If some only have
   signs's DNS, point them (or the router's DHCP DNS) at 10.1.1.11 until the
   upgrade is done.

## Phase 3: each hop (20.04 → 22.04, then 22.04 → 24.04)

Do one hop, verify, live with it for a day or two, then the next.

1. **Snapshot** (if `vgs` showed space; size it to the free space, at least 50 GB):
   ```bash
   sudo lvcreate -s -n root-pre-upgrade -L 50G ubuntu-vg/root
   ```
2. **Run the upgrade inside tmux** (it survives an SSH drop; over SSH the
   upgrader also starts a fallback sshd on port 1022, and ufw must allow it):
   ```bash
   sudo ufw allow 1022/tcp
   tmux new -s upgrade
   sudo do-release-upgrade
   ```
   Answers to the prompts:
   - Third-party sources are disabled: **yes** (re-enabled below).
   - Modified config files: **keep your version** for
     `/etc/systemd/resolved.conf`, anything under `/etc/apache2`,
     `/etc/samba/smb.conf`, `/etc/ssh/sshd_config`, `/etc/default/*`.
     When unsure, keep yours and diff later (`*.dpkg-dist` files).
   - Restart services automatically: **yes**.
   - Remove obsolete packages: **yes**, but read the list first. Stop and
     say no if it includes `network-manager`, `docker-ce`, `apache2`,
     `certbot`, `cifs-utils` or `plexmediaserver`.
3. **Reboot** when it asks.
4. **Re-enable Docker's repo** for the new release (`jammy` for 22.04,
   `noble` for 24.04), then update:
   ```bash
   sudo sed -i 's/ focal / jammy /; s/^# *deb/deb/' /etc/apt/sources.list.d/docker.list   # noble on hop 2
   sudo apt update && sudo apt install --only-upgrade docker-ce docker-ce-cli containerd.io docker-compose-plugin
   ```
   Do the same for Plex if its source was commented out
   (`/etc/apt/sources.list.d/plexmediaserver.list`; its repo isn't
   release-specific, so just uncomment it).
5. **Verify** (next section). If something is broken and can't be fixed
   quickly, roll back.
6. **Remove the snapshot** once you're happy (a snapshot that fills up is
   invalidated, so don't leave it for weeks):
   ```bash
   sudo lvremove ubuntu-vg/root-pre-upgrade
   sudo ufw delete allow 1022/tcp
   ```

### Rollback (only with a snapshot)

```bash
sudo lvconvert --merge ubuntu-vg/root-pre-upgrade
sudo reboot     # the merge completes as the volume activates; the system comes back as it was
```

`/boot` is on the root volume, so the old kernels come back too. The EFI
partition isn't in the snapshot; the newer GRUB EFI binary boots the old
system fine.

## Verify (after Phase 1 and after each hop)

```bash
lsb_release -d; uname -r
systemctl --failed                                   # compare with the baseline
ip -br addr | grep -E 'eno1|eno1.60|macvlan-host'    # all UP; macvlan-host has 10.1.1.1
systemctl status macvlan-host --no-pager | head -5
docker ps --format '{{.Names}} {{.Status}}' | sort | diff ~/pre-upgrade-docker.txt -   # only uptimes differ
dig +short djperron.com @10.1.1.21; dig +short djperron.com @10.1.1.22   # CoreDNS and Pi-hole answer
sudo apache2ctl configtest
curl -sI https://djperron.com/bets/healthz | head -1  # and /calcium, /meet, /webhooks/
sudo certbot renew --dry-run
findmnt -t cifs                                      # all five NAS mounts
sudo ufw status | head -5
pro status | grep -E 'esm|livepatch'; canonical-livepatch status | head -3
~/docker-compose/webhook-docker/ops/backup-signs     # ends "backup finished ok"
```

Also open Home Assistant (port 8123) and Plex (port 32400) once, and load
https://djperron.com/bets on a phone.

## After 24.04

- **Kernel and libraries:** glibc 2.39 and a modern g++, so
  `bet-tracker/bin/dev` becomes optional (better-sqlite3 prebuilt binaries
  will load on the host).
- **Pro and ESM:** carry over; 24.04's standard support runs to 2029, ESM to 2034.
- **Python:** the system Python is now 3.12. Nothing on signs depends on the
  old system Python as far as the survey found; `fnm` Node installs are
  per-user and unaffected.
