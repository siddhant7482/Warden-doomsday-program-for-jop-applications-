# Deploying Warden

Runs as an LXC container on Proxmox. Node and pnpm on the host, no
Docker inside the container — an extra daemon per app is not free on a
4-thread machine with ~120GB of disk.

```bash
# in the container
git clone <repo> /srv/warden && cd /srv/warden
pnpm install --prod=false
pnpm --filter warden build          # standalone output
cp apps/warden/.env.example apps/warden/.env.local   # then fill it in
pnpm --filter warden db:push
```

`.env.local` must contain `DATABASE_URL` pointing at CT 100, an
`OPENROUTER_API_KEY`, a `TOKEN_ENCRYPTION_KEY`, the Google OAuth
credentials, and SMTP settings.

## Connect the mailboxes

Register the redirect URI in Google Cloud against the **real host**, not
localhost:

```
http://jobs.hq/api/auth/google/callback
```

Then visit `/api/auth/google` once per mailbox, and check what it sees
before letting it write anything:

```bash
pnpm --filter warden sync --dry
```

## Schedule it

```bash
cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now warden-sync.timer warden-tick.timer
systemctl list-timers 'warden-*'
```

- `warden-sync` — every 15 minutes. Pulls mail, resolves applications,
  sweeps ghosts.
- `warden-tick` — 09:00 daily. Evaluates the ladder and sends what is
  due. Idempotent: a double fire emails nobody twice.

## Arming the ladder

Nothing reaches a witness until this is done deliberately.

```bash
pnpm --filter warden tick --smtp    # prove the credentials, email nobody
pnpm --filter warden tick           # dry run: exactly what would send
pnpm --filter warden tick --arm     # refuses while any address is a placeholder
```

Brief the witnesses first. An unexplained message about someone's job
search reads as confusing or worrying, and they will ignore the next
one — which makes the whole ladder a bluff.

`tick --disarm` stops all mail without touching the timers.
