# An app may call tools, and its consent is read off its own source

An app's page may fetch live data and may write — a tap that switches something. That is model-written
code calling into a real house, and the design's centre is that the user agrees to it once, before the
app is ever opened, and that the agreement is derived rather than declared.

**Derived** because the parser already reports what a page calls. Every parse of a page returns the
query and mutation statements it names, so the set of tools an app may call is the union of the names
its pages mention. Nothing has to be remembered by the model, no directive has to survive a rewrite,
and — the property that makes the consent honest — **an app cannot call something it never wrote.**
The list is computed when the app is saved, shown grouped as what it can read and what it can act on,
and stored with the record. A later page that adds a tool asks again, showing only the difference.

**Enforced on the host**, on the route that runs the call. A check in the app would be a suggestion:
the page is code a model wrote, and the record is the one thing it cannot edit.

Reads from the bot's own routes carry no consent. They are the user's own data on their own machine,
already behind the plugin's key, and a list of everything a bot may read is noise rather than
agreement. Only a call into someone's own services — the MCP servers a profile has configured — is
consented.

The call path itself is new, and it is deliberately not the agent's. Hermes already runs MCP tools for
an agent, and that path asks a person before a call and trips a breaker when one fails; an app that
refreshes on open cannot ask. So the plugin carries its own client, which means the hard case is a
remote server whose tokens Hermes holds — a second client cannot borrow them — while local servers,
which is what a home setup normally is, are the tractable first case.

A write shows a pending state until the answer arrives, never an optimistic flip. The Renderer already
has that state for a mutation it runs; a control that reads "on" before the house agreed is a lie with
a short life.

## Considered options

- **Reads only.** Safest, and rejected by the owner: a dashboard that cannot switch a light is a
  picture of a house.
- **Every call consented.** One prompt per tool, on first use. Rejected as friction that teaches
  people to tap through: the moment of decision is saving the app, where the whole of what it can do
  is in front of them.
- **Never consent, trust the app.** Rejected: the artifact is model-written code and this would be
  the only place in the product where that runs unattended.
- **Reuse the agent's MCP path.** Rejected on its approval step, which cannot be satisfied by an app
  opening on a phone.
- **A declaration the model writes by hand.** A directive line in the source. Rejected because it can
  drift from what the page actually names, and a declaration that disagrees with the code is worse
  than none.

## Consequences

- **The tool list is a property of the app, stored with it,** so a built-in carries one from the
  moment it is seeded and the list travels with an app that is hidden, edited or updated.
- **Every call is one route,** so the refusals, the size caps and the error shape live in one place
  rather than beside each caller.
- **A refusal must be drawable.** An undeclared or failed call answers a value the page renders, never
  a silent no-op: an app that looks like it acted when it did not is the failure this record exists to
  prevent.
- **Remote servers are a second step.** Local stdio servers are the first case; a remote server's
  tokens are a question this record leaves open rather than pretends to answer.
