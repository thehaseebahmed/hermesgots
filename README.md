<h1 align="center">Memento</h1>

<p align="center"><strong>Your agent, in your pocket.</strong></p>

<p align="center">
  <a href="https://app.netlify.com/projects/hermes-companion/deploys"><img alt="Netlify Status" src="https://api.netlify.com/api/v1/badges/5e7733ce-e51d-4d60-adc3-c0e5b8fdb5e5/deploy-status"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-black.svg"></a>
</p>

Memento is the app for [Hermes Agent](https://github.com/NousResearch/hermes-agent). Ask for something. Close the app. Come back to find it done.

It runs on your phone, your tablet and your laptop, in light and in dark. Your agent stays where it already lives: on your own machine.

## It keeps going

Most apps need to stay open to be useful. Memento doesn't. The work happens on your Hermes host, so a routine fires at 3 a.m. and a coding session carries on while your phone sleeps. When the agent needs you, a notification says that something is waiting. Never what it asked.

## Watch it think

Tool calls appear as the agent makes them, grouped and readable, with the file edits counted at a glance. When it plans a long task, a small pill keeps score. When it needs a decision, the question takes the place of the message bar, one tap from answered. Approvals work the same way.

You see what the agent is doing. You never have to read a log.

## Code, without the laptop

Pick a few GitHub repos and Memento turns them into a project. Every session gets its own branch and its own copy of the code, so ten ideas never step on each other. Tell it what you want, choose how much freedom it has, and let it work:

- **Plan** reads the code and hands you a plan to approve before a single line changes.
- **Accept edits** works freely and asks before anything risky.
- **Auto** just gets on with it.

When the work is done and checked, the agent opens the pull request itself. You see its state and its checks, right where you were chatting. Merge it, and the session resolves itself.

## Many agents, one place

Every Hermes profile is a bot with its own face and its own model. Switch models for a single chat. Attach a photo or a file. Dictate instead of typing. Check every routine you have scheduled, see how its last 24 runs went, and run one right now.

## Yours, completely

Your conversations stay on your Hermes host, in the transcripts Hermes already keeps. There is no Memento server in the middle holding your chats.

Sync between your devices is end-to-end encrypted with a key the server never sees. Your API keys are sealed before they leave your host. The server only ever sees ciphertext, and the code is open for anyone to read.

## Get started

Memento is in public beta. It works with Hermes Agent v2026.9.24 and later. Live reply text needs a newer Hermes than that release; [here is why](docs/troubleshooting.md#known-limitations).

- **[Quickstart](docs/quickstart.md):** from nothing to your first chat in about ten minutes.
- **[Docs](docs/README.md):** reaching your host over HTTPS, troubleshooting, the plugin and self-hosting.
- **[Report a problem](https://github.com/thehaseebahmed/memento/issues):** this is a beta. Tell us what broke.

Memento is [MIT licensed](LICENSE).
