# Troubleshooting

Known limitations of the beta, and fixes for the problems people hit first. See also [Quickstart](quickstart.md) and [Reaching Hermes over HTTPS](https.md).

## Known limitations

- **No live text on Hermes v2026.9.24.** That release doesn't let browsers read a reply's live event stream. Memento falls back to checking every few seconds: tool calls show with a short delay and the reply appears when it's finished. Hermes's `main` branch already has the fix.
- **iPhone and iPad:** there's no iOS app yet. Use the web app from your Home Screen; notifications only work there.
- **Voice input** needs a browser with speech recognition (Chrome, Edge, Safari) or the Android app.
- **Profiles under `/p/<name>`** need the plugin installed and enabled in that profile too: `hermes -p <name> plugins install thehaseebahmed/memento/plugin --enable`.

## Fixes

**The bot says "Can't reach it from this device".**
Open `https://<your bot's address>/health` in your phone's browser. You should see `{"status": "ok", …}`.
- If the page doesn't load, the HTTPS address isn't working: check your tunnel or Tailscale ([HTTPS guide](https.md)).
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
