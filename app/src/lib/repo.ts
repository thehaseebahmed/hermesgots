/**
 * Where the plugin is installed from, and the commands that install and link it: one leaf so every
 * command the app prints names the same repository. These strings went stale once already, when the
 * repository was renamed (`memento` → `hermesgots`), and nothing in the gates noticed because each
 * copy was a literal of its own (`scripts/test-install-instructions.mjs` sweeps for the old path).
 *
 * Import-free, so the unit tier loads it without a bundler or an install.
 */
export const REPO = "thehaseebahmed/hermesgots"

/** The plugin's directory in that repository, which is what `hermes plugins install` clones. */
export const PLUGIN_REPO = `${REPO}/plugin`

/** The repository's own page, for a release or a new issue. */
export const REPO_URL = `https://github.com/${REPO}`

/** What installs the plugin on a Hermes host, and makes the gateway load it. */
export const INSTALL_PLUGIN = `hermes plugins install ${PLUGIN_REPO} --enable
hermes gateway restart`

/** What installs the plugin and links this profile to the account, reached at `site`. */
export function installAndLink(code: string, site: string) {
  return `hermes plugins install ${PLUGIN_REPO} --enable
hermes gots link ${code} --site ${site}`
}

/** The same link step for another profile on the same host, which is already installed. */
export function linkProfileAt(code: string, site: string) {
  return `hermes -p <name> gots link ${code} --site ${site}`
}
