# Quickstart

From nothing to your first chat and your first pull request. It takes about ten minutes, most of it setting up HTTPS.

## What you need

- **Hermes Agent v2026.9.24 or newer**, already set up with a model you can chat with (`hermes` works in a terminal).
- **A way for your phone to reach Hermes over HTTPS.** The web app runs on `https://`, and browsers block it from calling a plain `http://` server on another machine. [Reaching Hermes over HTTPS](https.md) shows two ways to set this up in a few minutes. The Android app can also reach a plain-HTTP server on your home network.
- **A GitHub account** to sign in to Memento.
- **For coding sessions:** `git` on the Hermes host, and a GitHub login there (`gh auth login`) to clone private repos and open pull requests.

## 1. Open Memento

- **Phone or tablet browser:** go to [hermes-companion.netlify.app](https://hermes-companion.netlify.app) and add it to your home screen (Chrome's **Install app** or Safari's **Share → Add to Home Screen**).
- **Android app:** download the APK from the [latest release](https://github.com/thehaseebahmed/memento/releases) and install it.

## 2. Sign in and turn on sync

Sign in with GitHub, then turn on sync. Memento creates an encryption key on your device and asks you to save a **recovery code** (and, where your browser supports it, a passkey). Keep the recovery code somewhere safe: it is the only way to unlock sync on a new device if you have no passkey there.

Everything Memento syncs through its server is end-to-end encrypted. The server stores ciphertext only, and never sees your Hermes API keys or your messages.

## 3. Link your Hermes bot

The **Link your bots** screen shows two commands with a one-time link code. Run them on your Hermes host:

```bash
hermes plugins install thehaseebahmed/memento/plugin --enable
hermes memento link <code> --site https://hermes-companion.netlify.app
```

The first installs the [Memento plugin](../plugin/README.md), which Memento needs on every bot. The second links this Hermes profile to your account. It asks:

1. **The URL your phone reaches this profile at.** Enter the HTTPS address from [the HTTPS guide](https.md), for example `https://hermes.example.com`.
2. **Whether to add the lines Memento needs to `~/.hermes/.env`**: an `API_SERVER_KEY` if there is none, `API_SERVER_ENABLED=true`, and Memento's addresses in `API_SERVER_CORS_ORIGINS`. Say yes.

Then restart the gateway so it loads the plugin and the new settings:

```bash
hermes gateway restart
```

The bot appears in the app within a few seconds, marked **Ready** once your device can reach it. The code lasts 30 minutes. If it expires, the screen shows a new one.

**More than one profile?** Each Hermes profile is its own bot. Run `hermes -p <name> memento link <code> --site …` for each one, as the screen shows.

## 4. Your first chat

Tap **New chat**, pick a bot above the message bar, and send a message. The reply streams in with the tools the agent uses. When the agent wants to run a risky command it asks for your **approval**, and when it needs a decision it asks a **question**. Both appear in place of the message bar.

The model pill in the message bar switches this chat to another of the models your Hermes host has set up. The **+** button adds photos and files.

## 5. Your first coding session

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
