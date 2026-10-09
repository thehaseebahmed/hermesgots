# Memento

<p align="center">
  <a href="https://app.netlify.com/projects/hermes-companion/deploys"><img alt="Netlify Status" src="https://api.netlify.com/api/v1/badges/5e7733ce-e51d-4d60-adc3-c0e5b8fdb5e5/deploy-status"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-black.svg"></a>
</p>

A playful, minimal companion app for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Chat with your Hermes bots from your phone or tablet, answer their questions and approvals, watch your routines, and run coding sessions that end in a pull request. Ask for something, close the app, and come back to find it done.

> **Public beta.** Memento works, but expect rough edges. Please [open an issue](https://github.com/thehaseebahmed/memento/issues) when something breaks or confuses you.

## What you need

- **Hermes Agent v2026.9.24 or newer**, already set up with a model you can chat with (`hermes` works in a terminal).
- **A way for your phone to reach Hermes over HTTPS.** The web app runs on `https://`, and browsers block it from calling a plain `http://` server on another machine. [Reaching Hermes over HTTPS](docs/https.md) shows two ways to set this up in a few minutes. The Android app can also reach a plain-HTTP server on your home network.
- **A GitHub account** to sign in to Memento.
- **For coding sessions:** `git` on the Hermes host, and a GitHub login there (`gh auth login`) to clone private repos and open pull requests.

## Get started

### 1. Open Memento

- **Phone or tablet browser:** go to [hermes-companion.netlify.app](https://hermes-companion.netlify.app) and add it to your home screen (Chrome's **Install app** or Safari's **Share → Add to Home Screen**).
- **Android app:** download the APK from the [latest release](https://github.com/thehaseebahmed/memento/releases) and install it.

### 2. Sign in and turn on sync

Sign in with GitHub, then turn on sync. Memento creates an encryption key on your device and asks you to save a **recovery code** (and, where your browser supports it, a passkey). Keep the recovery code somewhere safe: it is the only way to unlock sync on a new device if you have no passkey there.

Everything Memento syncs through its server is end-to-end encrypted. The server stores ciphertext only, and never sees your Hermes API keys or your messages.

### 3. Link your Hermes bot

The **Link your bots** screen shows two commands with a one-time link code. Run them on your Hermes host:

```bash
hermes plugins install thehaseebahmed/memento/plugin --enable
hermes memento link <code> --site https://hermes-companion.netlify.app
```

The first installs the [Memento plugin](plugin/README.md), which Memento needs on every bot. The second links this Hermes profile to your account. It asks:

1. **The URL your phone reaches this profile at.** Enter the HTTPS address from [the HTTPS guide](docs/https.md), for example `https://hermes.example.com`.
2. **Whether to add the lines Memento needs to `~/.hermes/.env`**: an `API_SERVER_KEY` if there is none, `API_SERVER_ENABLED=true`, and Memento's addresses in `API_SERVER_CORS_ORIGINS`. Say yes.

Then restart the gateway so it loads the plugin and the new settings:

```bash
hermes gateway restart
```

The bot appears in the app within a few seconds, marked **Ready** once your device can reach it. The code lasts 30 minutes. If it expires, the screen shows a new one.

**More than one profile?** Each Hermes profile is its own bot. Run `hermes -p <name> memento link <code> --site …` for each one, as the screen shows.

### 4. Your first chat

Tap **New chat**, pick a bot above the message bar, and send a message. The reply streams in with the tools the agent uses. When the agent wants to run a risky command it asks for your **approval**, and when it needs a decision it asks a **question**. Both appear in place of the message bar.

The model pill in the message bar switches this chat to another of the models your Hermes host has set up. The **+** button adds photos and files.

### 5. Your first coding session

1. Open **Code** and tap **New project**. Name it and pick one or more GitHub repos. Hermes clones them on its host, so you can close the app while it works.
2. Open the project and tap **New session**. Describe the task and send it.
3. The agent works in its own git branch and worktree, so sessions never step on each other. The **+** button sets the session's mode:
   - **Accept edits** (default): the agent edits freely and asks before risky commands.
   - **Auto**: risky commands run without asking. Hermes's hard blocklist still applies, and questions still wait for you.
   - **Plan**: the agent only reads, then presents a plan for you to approve.
4. When the work is done and checked, the agent opens a pull request itself. The pill above the message bar shows its state and checks. Merging it marks the session resolved.

## Updating the plugin

The web app updates itself, and the Android app when you install a newer APK. When the plugin falls behind, update it on the Hermes host. Stop the gateway first: newer Hermes versions refuse to update a plugin while the gateway runs.

```bash
hermes gateway stop
hermes plugins update memento
hermes gateway start
```

## Known limitations

- **No live text on Hermes v2026.9.24.** That release doesn't let browsers read a reply's live event stream. Memento falls back to checking every few seconds: tool calls show with a short delay and the reply appears when it's finished. Hermes's `main` branch already has the fix.
- **iPhone and iPad:** there's no iOS app yet. Use the web app from your Home Screen; notifications only work there.
- **Voice input** needs a browser with speech recognition (Chrome, Edge, Safari) or the Android app.
- **Profiles under `/p/<name>`** need the plugin installed and enabled in that profile too: `hermes -p <name> plugins install thehaseebahmed/memento/plugin --enable`.

## Troubleshooting

**The bot says "Can't reach it from this device".**
Open `https://<your bot's address>/health` in your phone's browser. You should see `{"status": "ok", …}`.
- If the page doesn't load, the HTTPS address isn't working: check your tunnel or Tailscale ([HTTPS guide](docs/https.md)).
- If it loads but the bot still can't be reached, Hermes is refusing the app's origin. Check that `API_SERVER_CORS_ORIGINS` in `~/.hermes/.env` includes `https://hermes-companion.netlify.app` (and `https://localhost` for the Android app), then run `hermes gateway restart`.
- If the address changed, run `hermes memento link --url https://<new address>` on the host.

**The bot says "Can't reach its Memento plugin".**
The plugin isn't loaded in that profile. Run `hermes plugins list` to check it's installed and enabled, then `hermes gateway restart`.

**The link command fails.**
"That isn't a Memento link code" or an expired code: copy a fresh command from the app. "The account's key doesn't match": the code was copied from another account's screen; copy it again from yours. `hermes memento status` shows whether a profile is linked and checks in.

**Replies appear all at once.**
See [Known limitations](#known-limitations). Behind Cloudflare, also make sure you're using a named tunnel: quick tunnels (`trycloudflare.com`) don't carry live updates.

**Code says "No GitHub account".**
Run `gh auth login` on the Hermes host (or set `GITHUB_TOKEN` in `~/.hermes/.env`), then try again. Public repos still clone without it.

**Something else?** `hermes logs` on the host usually says why. [Open an issue](https://github.com/thehaseebahmed/memento/issues) with what you tried.

## Running your own copy

Memento is open source (MIT). To deploy your own copy, build the Android app, or work on the code, see [Self-hosting and development](docs/self-hosting.md). [AGENTS.md](AGENTS.md) describes the codebase and how Memento uses Hermes's API.
