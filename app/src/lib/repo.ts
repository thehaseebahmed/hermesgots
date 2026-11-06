export const REPO = "thehaseebahmed/hermesgots"

/** The plugin's directory in that repository, which is what `hermes plugins install` clones. */
export const PLUGIN_REPO = `${REPO}/plugin`

export const REPO_URL = `https://github.com/${REPO}`

export const INSTALL_PLUGIN = `hermes plugins install ${PLUGIN_REPO} --enable
hermes gateway restart`

export function installAndLink(code: string, site: string) {
  return `hermes plugins install ${PLUGIN_REPO} --enable
hermes gots link ${code} --site ${site}`
}

export function linkProfileAt(code: string, site: string) {
  return `hermes -p <name> gots link ${code} --site ${site}`
}
