# Putting it online

This guide gets the reader running at an address like `https://yourname.duckdns.org`, where
only the Google accounts you list can open it. Everything in it is free:

- **[Oracle Cloud Always Free](https://www.oracle.com/cloud/free/)** for a server that stays on
- **[DuckDNS](https://www.duckdns.org)** for the address
- **[Caddy](https://caddyserver.com)** for HTTPS, with a free certificate it renews by itself
- **Google** for sign-in, so the app never stores a password

Two things to know first. Everyone you let in shares **one library**: they see the same PDFs,
reading positions and lookups. And their lookups use **your AI key**.

It takes about an hour, mostly waiting on sign-up pages. Wherever you see `yourname.duckdns.org`
or `<server-ip>`, put in your own.

## 1. Get a server

1. Sign up at <https://www.oracle.com/cloud/free/>. It asks for a card to check who you are;
   Always Free resources aren't charged.
2. Create a compute instance:
   - **Image:** Canonical Ubuntu 24.04
   - **Shape:** Ampere, `VM.Standard.A1.Flex`, 2 OCPUs and 12 GB of memory
   - **SSH keys:** paste your public key (`cat ~/.ssh/id_ed25519.pub` on your Mac)
3. If it says *out of capacity*, pick another availability domain, or try again later. This is
   common and not your fault.
4. Note the instance's **public IP address**.

## 2. Open the web ports

The server sits behind two firewalls, and both need ports 80 and 443 open. Leave 3210 closed:
only Caddy, on the same machine, should reach the app directly.

1. **In the Oracle console:** open the instance's subnet, then its *security list*, and add two
   ingress rules: source `0.0.0.0/0`, TCP, destination port `80`, then the same for `443`.
2. **On the server:** Oracle's Ubuntu images come with their own rules that block everything but
   SSH.

   ```bash
   ssh ubuntu@<server-ip>
   sudo iptables -I INPUT -p tcp -m multiport --dports 80,443 -m conntrack --ctstate NEW -j ACCEPT
   sudo netfilter-persistent save
   ```

## 3. Get an address

Sign in at <https://www.duckdns.org>, create a subdomain, and set its IP to your server's public
IP. That gives you `yourname.duckdns.org`. If the server's IP ever changes, update it there.

## 4. Create a Google sign-in client

1. Open <https://console.cloud.google.com> and create a project (any name).
2. Go to **Google Auth Platform** (in older menus: *APIs & Services → OAuth consent screen*):
   - **Branding:** an app name and your email as the support address.
   - **Audience:** *External*, and leave it in **Testing**. Add each person who should get in as
     a **test user**. In Testing, Google itself only lets test users sign in, so your list is
     enforced twice.
3. Go to **Clients → Create client**:
   - **Application type:** Web application
   - **Authorized redirect URIs:** `https://yourname.duckdns.org/auth/callback`.
     Add `http://localhost:3210/auth/callback` as well if you want to
     [try sign-in on your Mac](#trying-sign-in-on-your-mac-first) first.
4. Copy the **client ID** and **client secret**.

The app asks only for your email address (`openid email`), so Google doesn't need to review it.

## 5. Install the app

On the server, install Node.js:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

On your Mac, **stop the app first**, so the database copies cleanly. Then, from the project
folder, copy everything over: the code, your library (`pdfs/`, `data/`) and `.env`.

```bash
rsync -av --exclude node_modules --exclude models ./ ubuntu@<server-ip>:~/smart_pdf_reader/
```

Back on the server:

```bash
cd ~/smart_pdf_reader
npm ci --omit=dev
```

## 6. Add the sign-in settings

Add these to `~/smart_pdf_reader/.env` on the server:

```ini
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
ALLOWED_EMAILS=you@gmail.com, friend@gmail.com
PUBLIC_URL=https://yourname.duckdns.org
```

You don't need `AUTH=google` here. The service in the next step turns sign-in on by itself.

## 7. Start it

The service keeps the app running, and restarts it after a crash or a reboot. It's set up so the
app **cannot start without sign-in**, whatever `.env` says. If you copied the project somewhere
other than `/home/ubuntu/smart_pdf_reader`, change the paths in
`deploy/smart-pdf-reader.service` first.

```bash
sudo cp deploy/smart-pdf-reader.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now smart-pdf-reader
journalctl -u smart-pdf-reader -n 20
```

The log should end with `Sign-in: Google, 2 allowed addresses`. If a setting is missing, it says
which one and the app doesn't start. Fix `.env`, then `sudo systemctl restart smart-pdf-reader`.

## 8. Put HTTPS in front

```bash
sudo apt-get install -y caddy
sed 's/yourname.duckdns.org/<your address>/' deploy/Caddyfile | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If `apt` can't find `caddy`, follow [Caddy's install steps for Ubuntu](https://caddyserver.com/docs/install#debian-ubuntu-raspbian).
If you changed `PORT` in `.env`, change `3210` in the Caddyfile to match.

Open `https://yourname.duckdns.org`. The first visit can take a few seconds while Caddy gets its
certificate. Sign in with Google, and you're in your library.

## Looking after it

**Letting someone in, or out.** Edit `ALLOWED_EMAILS` in `.env` (and the test users in Google),
then `sudo systemctl restart smart-pdf-reader`. Someone you remove is locked out straight away,
even if they're in the middle of reading.

**Updating the app.** From your Mac, copy the code only. Leave out `pdfs/`, `data/` and `.env`,
or your Mac's older copies will overwrite the server's:

```bash
rsync -av --exclude node_modules --exclude models --exclude pdfs --exclude data --exclude .env \
  ./ ubuntu@<server-ip>:~/smart_pdf_reader/
ssh ubuntu@<server-ip> 'cd ~/smart_pdf_reader && npm ci --omit=dev && sudo systemctl restart smart-pdf-reader'
```

**Backing up.** Oracle can take back an Always Free server that sits almost idle for a week, and
a reading app is idle most of the time. Upgrading the account to *Pay As You Go* stops that, and
costs nothing as long as you stay inside the free limits. Either way, copy your library home
now and then:

```bash
ssh ubuntu@<server-ip> 'sudo systemctl stop smart-pdf-reader'
rsync -av ubuntu@<server-ip>:~/smart_pdf_reader/{pdfs,data} ./backup/
ssh ubuntu@<server-ip> 'sudo systemctl start smart-pdf-reader'
```

## Trying sign-in on your Mac first

Sign-in is behind a flag, `AUTH`, and it's off unless you turn it on. To try it locally, add the
`http://localhost:3210/auth/callback` redirect URI to your Google client (step 4), then put this
in your Mac's `.env` and restart the app:

```ini
AUTH=google
GOOGLE_CLIENT_ID=1234567890-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=your-client-secret
ALLOWED_EMAILS=you@gmail.com
```

`PUBLIC_URL` defaults to `http://localhost:3210`, so it isn't needed here. To turn sign-in off
again, remove `AUTH=google` or set `AUTH=off`.
