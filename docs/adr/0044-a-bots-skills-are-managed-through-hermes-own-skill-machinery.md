# A bot's skills are managed through Hermes's own skill machinery, per profile

Gots lets a user see, switch off and remove the skills a bot has. Skills belong to a Hermes profile —
one bot — and their state and their files are that profile's own (`skills.disabled` in its
`config.yaml`, its `skills/` directory), so every read and write goes through Hermes's own in-process
functions (`tools.skills_tool`, `hermes_cli.skills_config`, the same inner skill helpers the
dashboard itself calls, `tools.skills_hub_install`) inside that profile's scope, never through Gots
editing files or YAML itself and never through the dashboard's `/api/skills` routes, which answer
only on the host's loopback with a rotating token the app cannot reach. A write that changes or
removes a skill calls those inner helpers rather than `skill_manage`, which stages every write
through the agent write-approval gate — a shape made for an agent editing its own skills, not for a
user driving a screen who has already decided. One read serves the composer's slash menu and the
Skills tab alike, resolving the helper's name across Hermes versions (`find_all_skills` /
`sort_skills`, with the older underscored names as a fallback), because a host that answers 501 for
its skills list has no slash menu at all.

## Consequences

- The switch writes the profile's global `skills.disabled` list and nothing else: a skill is off for
  that bot, full stop. The per-platform slot exists but is not what Gots writes, since a bot's host
  is one machine and two switches would mean two answers to "is it on?".
- Removing is three different Hermes operations by origin. A hub skill goes through the hub's own
  uninstall, which refuses anything outside its lock file ("may be a builtin"); a skill written on
  the profile goes through the delete helper, which itself refuses pinned and essential skills; a
  built-in has no removal at all, so its row carries no Remove. A plugin skill gets the switch and
  nothing else: Hermes honours its disabled name, but the write helpers never walk a plugin's
  namespace.
- Each write clears Hermes's own skills and prompt caches, so the change is live for the next turn
  without a reload and without the consent-gated paths.
- A chat that was already built keeps the abilities it had; the change lands on the profile, not a
  session in flight.
- The plugin advertises `skills`, `skills_write`, `skills_remove` and `skills_view` only where these
  built-ins import, so a bot on an older Hermes has no tab, and each verb disappears where the host
  cannot honour it.
- Turning a skill off hides it everywhere Gots offers skills — the slash menu and the skill pickers —
  because one list serves them all.
