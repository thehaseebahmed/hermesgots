# The plugin is `gots`, and `hermes gots migrate` moves `memento` over

The plugin's key, manifest name, route prefix (`/api/plugins/gots`), toolset, CLI command and session
id prefix (`gots-`) were `memento`. They are now `gots`. Nothing serves the old route prefix: one user
runs this, so the plugin and the app move together, and `MIN_PLUGIN_VERSION` is 0.109.0, the first
plugin that is `gots`.

The Android project's package and its `applicationId` are both `dev.hermesgots`. The id is the
installed app's identity and the name Firebase registers, so it needs an Android app registered under
it in the same Firebase project (the `FIREBASE_GOOGLE_SERVICES` secret's `google-services.json`
carries that client beside the old `app.memento` one), and an APK built with it installs as a
different app from the one before: the old install is uninstalled, not updated.

The plugin's data lives in Hermes's own per-plugin directory, `$HERMES_HOME/plugin-data/gots/`
(`store.data_dir`), not a folder the plugin named for itself. `store.home_of` finds the profile home
above a store.

`hermes gots migrate` (`plugin/migrate.py`) copies `$HERMES_HOME/memento/` (the store through SQLite's
backup, `attachments/`, `meetings/`, an owner-only `link.json`) into that directory, moves
`plugins.entries.memento` to `plugins.entries.gots` so the user's model-override grants survive, puts
both plugins in `plugins.disabled`, and says to run `hermes plugins enable gots`. It refuses to copy
while a gateway still answers on its control socket, and a second run changes nothing. The old folder
stays as the way back.

Hermes registers a plugin's CLI commands only while the plugin is enabled (`gate_manifest`,
`hermes_cli/plugins_discovery.py`), so the command cannot run with Gots disabled. It lives in the
enabled Gots plugin and does the disabling itself.

Session ids that start with `memento-` and the `memento` session sources are not rewritten. The plugin
reads both (`sessions.ID_PREFIXES`, `sessions.SOURCES_THIS_PLUGIN_WROTE`) so older sessions keep
working; new ones are `gots-`.

## Considered options

- **A third, always-enabled plugin that only holds the command.** Rejected: a second plugin to install
  and keep enabled, for a command that runs once.
- **Registering the command through the memory-provider hook**, the one path that skips the enabled
  gate. Rejected: it needs `memory.provider` changed and has nothing to do with this plugin.
- **Rewriting `memento-` ids and sources in the copied stores.** Rejected: the plugin already reads
  both, and a rewrite is a second way to corrupt a store for no reader that needs it.
- **Serving `/api/plugins/memento` as well, for older apps.** Rejected: nothing older is in use.
- **Keeping the Android `applicationId` as `app.memento`.** Rejected: the id is the app's own name,
  and the Firebase app and a re-install are the price of renaming it once.
- **Keeping `$HERMES_HOME/gots/`.** Rejected: Hermes already gives a plugin `plugin-data/<name>`.
