/**
 * The one rule for an untrusted document drawn in a frame (ADR 0114): an opaque-origin
 * `<iframe sandbox="allow-scripts" srcdoc>` — never `allow-same-origin` — whose head starts with a
 * policy and the safety scripts, ahead of anything the document's author wrote.
 *
 * The policy is the caller's, so the boxes that draw such a document (a canvas, the Previewer's page)
 * may differ in what they let in; the safety scripts are the same for all of them. A canvas composes
 * this with its theme, compiled classes and bridges; a page needs nothing more.
 *
 * Import-free, so `scripts/test-sandboxed-document.mjs` and `scripts/test-canvas-document.mjs` run
 * it as a pure rule.
 */

/**
 * The policy a sandboxed document is drawn under: nothing leaves the frame, and nothing loads from
 * outside it but an image over https (ADR 0134).
 */
export const SANDBOX_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; " +
  "font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'"

/**
 * WebRTC, taken away before the page's own scripts run: a peer connection is a way out of the
 * sandbox that no policy covers, and a sandboxed page has no reason to open one.
 */
export const NO_PEER = `(function(){var names=["RTCPeerConnection","webkitRTCPeerConnection","mozRTCPeerConnection"];for(var i=0;i<names.length;i++){try{delete window[names[i]]}catch(e){}try{window[names[i]]=undefined}catch(e){}}})()`

/**
 * A form's submit, kept on the page it was made on. `form-action 'none'` refuses the navigation, so
 * without this the reader is left on a refusal with the page's state gone; the guard cancels the
 * default instead, and the page stays whole.
 *
 * It listens on `window` in the bubble phase: a submit travels from the form up to the window, so every
 * handler the page put on the form or on a field has already run and kept whatever it did, and a submit
 * the page prevented itself arrives already prevented and is left alone. Only an unprevented submit is
 * cancelled, so nothing the page means to happen is taken away from it. One it put on the window itself
 * is registered after this and runs afterwards, which is the cost of being first in the head. The policy
 * does not move: this cancels a navigation, it does not permit one.
 */
export const SUBMIT_IN_PLACE = `(function(){addEventListener("submit",function(event){if(event&&!event.defaultPrevented){event.preventDefault()}},false)})()`

/**
 * Where the page's own head starts, searched for in its markup: a comment that mentions `<head>`
 * must not be where the policy lands, or the page would be drawn with no policy at all. The host's
 * scan reads a document the same way, so the two agree on what its head is.
 */
export function findHead(html: string): { index: number; length: number } | null {
  let at = 0
  for (;;) {
    const comment = html.indexOf("<!--", at)
    const end = comment === -1 ? html.length : comment
    const found = /<head\b[^>]*>/i.exec(html.slice(at, end))
    if (found) return { index: at + found.index, length: found[0].length }
    if (comment === -1) return null
    const closed = html.indexOf("-->", comment + 4)
    // An unterminated comment: nothing after it is markup, so there is no head to find.
    if (closed === -1) return null
    at = closed + 3
  }
}

/**
 * The policy a page the Previewer draws from a folder on the host is held to (ADR 0135): the
 * sandbox's, with the host's origin let in for its scripts, styles, images and fonts. The origin is
 * all a policy can name and still survive a redirect; what the page reaches on it is the folder its
 * token covers, which the host's route enforces. Connections, frames and form posts stay shut.
 */
export function folderPolicy(folder: string): string {
  const source = new URL(folder).origin
  return SANDBOX_CSP.replace("script-src 'unsafe-inline'", `script-src 'unsafe-inline' ${source}`)
    .replace("style-src 'unsafe-inline'", `style-src 'unsafe-inline' ${source}`)
    .replace("img-src data: blob: https:", `img-src data: blob: https: ${source}`)
    .replace("font-src data:", `font-src data: ${source}`)
}

const attribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")

/**
 * A page as the Previewer draws it: the sandbox head first, and — where the page lies in a folder the
 * host signed — a `<base href>` at that folder right after the policy, ahead of any of the page's
 * own markup, so every relative URL it names or its scripts build resolves there. A page with no
 * folder (one staged and not yet sent) is drawn under the plain sandbox policy, without its files.
 */
export function previewerPage(html: string, folder?: string): string {
  if (!folder || !/^https?:\/\//i.test(folder)) return sandboxedDocument(html, { policy: SANDBOX_CSP })
  return sandboxedDocument(html, {
    policy: folderPolicy(folder),
    afterPolicy: `<base href="${attribute(folder)}">`,
  })
}

/**
 * The markup with the sandbox head put first in its head: the policy, then `afterPolicy` (styles a
 * caller wants ahead of the scripts), then the safety scripts, then `afterSafety` (scripts a caller
 * hands the page). A meta policy only governs what follows it, so markup with no head of its own gets
 * one prepended rather than being drawn with the page ahead of its policy.
 */
export function sandboxedDocument(
  html: string,
  { policy, afterPolicy = "", afterSafety = "" }: { policy: string; afterPolicy?: string; afterSafety?: string },
): string {
  const prefix =
    `<meta http-equiv="Content-Security-Policy" content="${policy}">` +
    afterPolicy +
    `<script>${NO_PEER}</script>` +
    `<script>${SUBMIT_IN_PLACE}</script>` +
    afterSafety
  const head = findHead(html)
  if (!head) return `<head>${prefix}</head>` + html
  const at = head.index + head.length
  return html.slice(0, at) + prefix + html.slice(at)
}
