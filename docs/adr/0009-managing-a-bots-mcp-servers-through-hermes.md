# A bot's MCP servers are managed through Hermes's own built-ins, per profile

Gots lets a user see, add, switch on, switch off and remove the MCP servers a bot has. MCP servers
belong to a Hermes profile — one bot — and their configuration is that profile's `config.yaml`, so
every read and write goes through Hermes's own in-process functions (`hermes_cli.mcp_catalog`,
`hermes_cli.mcp_config`, `tools.mcp_tool_discovery`) inside that profile's write scope
(`config_write_scope(profile)`), never through Gots editing the YAML itself and never through the
dashboard's `/api/mcp/*` routes, which answer only on the host's loopback with a rotating token the
app cannot reach. An install uses Hermes's card-style path (`card_install_config` → probe →
`_save_mcp_server` → `save_env_value`) rather than `install_entry`, which can fall back to a bare
stdin prompt and open a curses checklist inside the host process, and each write is followed by
`reconcile_mcp_servers_with_config()` for that profile, which is Hermes's own unconsented reconcile —
so the change is live without Gots invoking the consent-gated `/reload-mcp`, which invalidates the
prompt cache.

## Consequences

- Server access cannot be granted in Gots. Hermes's in-process start binds a 127.0.0.1 receiver on
  the host, so the row asks the host for the URL and the user finishes it in a browser on the host;
  Gots shows the state and waits.
- Remove matches `hermes mcp remove`: the config entry, the cloned install directory and the stored
  access token go, while the API key stays in the profile's `.env`, where Hermes reuses it on a
  reinstall.
- A server a Hermes plugin package provides through its own `mcp.json` is read-only in Gots, because
  Hermes refuses to modify those.
- A chat that was already built keeps the abilities it had; the reconcile changes the profile, not a
  session in flight.
- The plugin advertises the feature only when these built-ins import, so a bot on an older Hermes
  simply has no screen.
