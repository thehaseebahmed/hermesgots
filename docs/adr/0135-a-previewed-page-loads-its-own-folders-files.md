# A previewed page loads its own folder's files, and nothing above it

**Amends [ADR 0134](0134-a-sandboxed-page-may-load-images-over-https.md)** (2026-11-10).

An HTML file the Previewer draws is usually one of several: a stylesheet beside it, a script, an
`img/` folder, a font. Drawn by `srcdoc` alone, with nothing but inline sources allowed, every one of
them is lost. Inlining them can't reach a path the page's own script builds, and a CSS `@import`.
So the page gets its folder:

- **One token over the folder.** When the app asks `POST media/url` for an `.html` file, the answer
  also carries `folder`: `…/media/page/<token>/`. The token names the folder (the validated file's
  parent, resolved), the profile and an expiry, and is signed with the media key over a prefix no
  file path carries, so a folder's token never reads as a file's and a file's never reads as a folder's.
  It lives as long as the file's URL. It sits in the address's path, not its query, because a
  `<base href>` drops the query.
- **The route serves only what is under it.** `GET media/page/<token>/<rest>` refuses a bad or spent
  token (401). It refuses a `..` or empty part, and a file whose resolved path (symlinks followed)
  isn't under the folder. Hermes's `validate_media_delivery_path` and the media route's size cap then
  apply as they do to every file this plugin serves (404/413). The file goes out with its own type
  (fonts and wasm included), `nosniff`, and `Access-Control-Allow-Origin: *`. The frame has an opaque
  origin, so it sends `Origin: null`, and a font or a module script loads only with CORS. The token
  is the gate, not the origin. The route is mirrored under `/p/<profile>` like every other.
- **The page's head.** The Previewer puts its policy first in the head, then `<base href=folder>`,
  then the safety scripts, ahead of anything the page wrote (`previewerPage` in
  `app/src/lib/sandboxed-document.ts`). That policy is the sandbox's with the host's origin added to
  `script-src`, `style-src`, `img-src` and `font-src`. `connect-src`, `frame-src` and `form-action`
  stay `'none'`, and `sandbox="allow-scripts"` stays without `allow-same-origin`.
- **Previewer only.** A canvas is a record with no folder, so its document has no base and its policy
  is unchanged. A page the user has staged but not sent isn't on the host yet, so it has no folder
  and draws under the plain sandbox policy, without its local files.
- **Feature flag.** The host advertises `media_page`. An older host answers no `folder`, and its
  pages draw as before.

**Consequences:** the page and its scripts can read every file in that folder and below for the
token's lifetime, including ones unrelated to the page. They can show them but can't send them
anywhere except encoded into a remote image URL (ADR 0134). The token is visible to the page's
scripts. It covers one folder, one profile, and minutes. Allowing the host's origin in the policy
also lets a page name other host routes, but every other route needs the bot's key or a signature
over a different path, so the origin grants nothing the token doesn't.
