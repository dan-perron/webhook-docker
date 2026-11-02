# Upgrading signs: Ubuntu 20.04 → 22.04 → 24.04

Written 2026-10-04 from a read-only survey of `signs`; re-checked
2026-10-11 (Phase 1 not yet done). Re-check the "Current state" facts
before starting; anything that changed since then changes the plan.

## Current state

- Ubuntu 20.04.6, kernel 5.4.0-231 running, 5.4.0-241 installed but not booted.
- Ubuntu Pro (free personal): ESM infra/apps and Livepatch on, so 20.04 keeps
  security updates until **April 2030**. Unattended upgrades on. The release
  upgrade is for newer libraries, not security.
- `/` (including `/boot` and `/var/lib/docker`) is the LVM volume
  `ubuntu-vg/root`, 467 GB, 165 GB used. `/boot/efi` is a separate partition.
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
  Every running container has `restart: unless-stopped`, including
  `embrace-core-api` (ports 3100/9329, from `~/repos/embrace-core`; its
  Postgres and Redis containers are stopped) and `apache-proxy` (port 8081,
  from the sabnzbd stack — separate from the host Apache).
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
2. **No LVM snapshot:** `sudo vgs` shows `VFree 0` (checked 2026-10-11; the
   root volume fills the disk), so there's no instant rollback. Instead each
   hop starts with a full copy of `/` to the NAS (Phase 3, step 1), restored
   from a live USB if needed (an hour or two, not a reboot).
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

1. **Full copy of `/` to the NAS** (about 30–60 min, services stay up):
   ```bash
   sudo ~/docker-compose/webhook-docker/ops/image-root
   ```
   It writes `/mnt/archive/backups/signs/rootfs/root-<release>-<date>.tar.gz`
   and tests it. Don't start the upgrade unless it ends with "done".
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
6. **Close the fallback SSH port** once you're happy:
   `sudo ufw delete allow 1022/tcp`. Keep the root copy until the next hop
   has succeeded, then delete it.

### Rollback without a snapshot

Boot an Ubuntu live USB ("Try Ubuntu") on `signs`, then:

```bash
sudo apt install -y cifs-utils pigz
sudo vgchange -ay ubuntu-vg
uuid=$(sudo blkid -s UUID -o value /dev/ubuntu-vg/root)   # reuse it so GRUB and fstab still match
sudo mkfs.ext4 -F -U "$uuid" /dev/ubuntu-vg/root           # wipes the upgraded system
sudo mkdir -p /mnt/root /mnt/nas
sudo mount /dev/ubuntu-vg/root /mnt/root
sudo mount -t cifs //thunderdome/archive /mnt/nas -o ro,username=<nas user>
sudo tar -xpf /mnt/nas/backups/signs/rootfs/root-20.04-<date>.tar.gz \
  --use-compress-program=pigz --numeric-owner --acls --xattrs --xattrs-include='*' \
  --exclude='./boot/efi/*' -C /mnt/root
sudo mount /dev/nvme0n1p1 /mnt/root/boot/efi             # then the old GRUB EFI files (vfat: no owners)
sudo tar -xf /mnt/nas/backups/signs/rootfs/root-20.04-<date>.tar.gz \
  --use-compress-program=pigz --no-same-owner --no-same-permissions -C /mnt/root ./boot/efi
sudo umount /mnt/root/boot/efi /mnt/root && sudo reboot
```

If it doesn't boot, chroot in from the live USB and run `grub-install` and
`update-grub`. Mongo and bet-tracker were copied live; if either won't start,
restore it from the nightly backup (`ops/README.md`).

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
