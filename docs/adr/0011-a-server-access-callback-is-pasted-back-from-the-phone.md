# A Server access callback is pasted back from the phone

Hermes starts an MCP server's OAuth flow in-process and binds a one-shot `127.0.0.1` receiver on the
bot's host for the browser's redirect, so the flow can only be finished by a browser that can reach
that loopback address. The screen's whole point is the phone, though, and a URL that must be carried
to another machine is a URL most users never finish. Opening it on the phone does the same work —
the provider redirects to the same `127.0.0.1` URL, the browser fails to connect, and the address bar
holds the redirect with its `code` and `state`.

So the sheet offers a paste field beside the URL. The pasted address is sent to the host over the
authenticated connection the app already uses; the plugin checks it names the running flow's own
redirect (scheme, host, port and path), then hands its query to the flow's `deliver_callback`, which
enforces the `state` with a constant-time compare and refuses a second delivery. The authorization
code never grants anything on the phone; the host exchanges it.

## Consequences

- The flow stays the Host's: the phone only relays the browser's redirect. A flow nobody finishes
  waits for the server's `oauth.timeout` (300s by default), and the sheet ends its own wait at that
  point rather than polling a status route.
- The pasted URL is a credential for exactly one exchange. It is never logged, and nothing about it
  is kept on the device.
- A start while a flow is already running answers with that flow's URL rather than minting a new one:
  Hermes's own start cancels an older attempt and binds a new port, which would kill a URL the user
  may already be pasting into.
- [ADR 0009](./0009-managing-a-bots-mcp-servers-through-hermes.md)'s "cannot be granted in Gots" is
  now "started in Gots, granted in a browser"; the host is still the only party that holds access.
