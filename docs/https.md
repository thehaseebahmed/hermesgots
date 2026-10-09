# Reaching Hermes over HTTPS

Memento's web app is served over `https://`, and browsers won't let an `https://` page call a plain `http://` server on another machine. So for your phone to talk to Hermes, Hermes needs an HTTPS address.

Hermes's API server listens on `http://127.0.0.1:8642` by default, which only the host itself can reach. Both options below put an HTTPS address in front of it without opening a port on your router or changing how Hermes listens.

| | Tailscale | Cloudflare Tunnel |
| --- | --- | --- |
| Who can reach it | **Serve:** only your own devices with Tailscale on. **Funnel:** anyone on the internet. | Anyone on the internet |
| Needs | A free Tailscale account | A Cloudflare account and a domain on Cloudflare |
| Address | `https://<machine>.<tailnet>.ts.net` | `https://<subdomain>.<your domain>` |

If you don't have a domain on Cloudflare, use Tailscale. Either way, Hermes still checks the bot's API key on every request; the link command sets one up.

> The Android app isn't bound by the browser's rule, so it can also use a plain `http://` address on your home network (for example `http://192.168.1.20:8642`, with `API_SERVER_HOST=0.0.0.0` in `~/.hermes/.env`). You'll still want HTTPS to use Memento away from home or in a browser.

## Option A: Tailscale

[Tailscale](https://tailscale.com) gives each of your devices a private address, and can serve a local port over HTTPS with a certificate it manages.

1. Install Tailscale on the Hermes host and sign in: `tailscale up`.
2. Share the API server:

   - **Serve** (recommended): only devices signed in to your tailnet can reach it. Install the Tailscale app on your phone and sign in with the same account.

     ```bash
     tailscale serve --bg 8642
     ```

   - **Funnel**: reachable from the whole internet, so your phone doesn't need Tailscale.

     ```bash
     tailscale funnel --bg 8642
     ```

   The first time, the command walks you through turning on HTTPS certificates (and Funnel) for your tailnet. It then prints the address, `https://<machine>.<tailnet>.ts.net`.

3. Link the bot with that address. When `hermes memento link` asks for the URL, enter it, or pass it straight away:

   ```bash
   hermes memento link <code> --site https://hermes-companion.netlify.app --url https://<machine>.<tailnet>.ts.net
   ```

`--bg` keeps sharing after the command exits. `tailscale serve status` shows what's shared, and `tailscale serve reset` (or `tailscale funnel reset`) stops it.

## Option B: Cloudflare Tunnel

A [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/get-started/) connects your host to Cloudflare with an outbound connection and publishes it at a hostname on your domain.

1. In the Cloudflare dashboard, go to **Networking → Tunnels** and select **Create Tunnel**. Name it (for example `hermes`), pick your host's operating system, and run the install command it shows on the Hermes host. Wait for the tunnel to show as connected, then select **Continue**.
2. Add a route: under **Routes**, select **Add route → Published application**.
   - **Hostname:** a subdomain on your domain, for example `hermes.example.com`.
   - **Service URL:** `http://localhost:8642`.
3. Link the bot with that address:

   ```bash
   hermes memento link <code> --site https://hermes-companion.netlify.app --url https://hermes.example.com
   ```

Two things to avoid:

- **Quick Tunnels** (`cloudflared tunnel --url …`, which give a `trycloudflare.com` address) don't support server-sent events, which Memento uses for live replies and updates, and their address changes every time. Use a named tunnel as above.
- **Cloudflare Access** in front of the hostname asks for a browser sign-in, which the app's requests can't do. Hermes's API key already protects the API server.

## Check it works

1. Open `https://<your address>/health` on your phone. You should see `{"status": "ok", …}`.
2. In Memento, the bot shows **Ready** on the link screen instead of "Can't reach it from this device".

If `/health` loads but the bot still can't be reached, the browser is being turned away by Hermes's CORS check. Make sure `API_SERVER_CORS_ORIGINS` in `~/.hermes/.env` lists `https://hermes-companion.netlify.app` and `https://localhost` (the Android app), comma-separated, then run `hermes gateway restart`. The link command offers to add both.

## Changing the address later

Run `hermes memento link --url https://<new address>` on the host. The bot's record updates on every device.

## Other profiles

A profile served by the main gateway (at `/p/<name>`) shares its address: link it with `--url https://<address>/p/<name>`, which the command suggests by default. A profile running its own gateway on another port needs its own Serve, Funnel or tunnel route for that port.

---

Checked against Cloudflare's [Tunnel get-started](https://developers.cloudflare.com/tunnel/get-started/) and [Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/) pages and the `tailscale` CLI's own help (`tailscale serve --help`) on 9 October 2026. Tailscale's knowledge base couldn't be opened from where this was written, so check [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) if a step differs.
