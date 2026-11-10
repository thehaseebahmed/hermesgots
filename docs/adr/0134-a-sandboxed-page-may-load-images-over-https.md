# A sandboxed page may load images over https, and nothing else from outside

**Amends [ADR 0114](0114-a-canvas-runs-in-a-sandbox-that-reaches-only-its-host.md)** (2026-11-10).

ADR 0114 drew a canvas under a policy that let nothing load from outside the frame. Pages commonly
show pictures that live elsewhere, and an HTML file the Previewer draws is going to be held to the
same rule as a canvas, so the two boxes share one policy (`app/src/lib/sandboxed-document.ts`) and
that policy now lets one thing in:

- **The frame's CSP:** `img-src data: blob: https:`. Every other directive is unchanged: scripts and
  styles inline only, fonts from `data:` only, no connections, no frames, no form posts.
- **`https:` only, not `http:`.** An https app would block a mixed-content image anyway, and one
  token keeps the policy readable.
- **The canvas scan follows the policy.** A write is accepted when an `<img src>`, an `<img srcset>`
  or a `<picture>`'s `<source srcset>` names images over `https://`. A plain `http://` or
  scheme-relative image is still refused, and so is every other load from outside: `<script src>`,
  `<link href>`, CSS `url(//…)`, `poster`, `action` and `formaction`. CSS backgrounds are covered by
  `img-src` in the browser, but the scan keeps refusing them: the user allowed remote *images*, and
  the scan's job is to refuse what would break silently. That can be loosened later.
- **The canvas prompt says so:** remote images over https are allowed; nothing else loads from
  outside.

**Consequence:** a remote image is a beacon. Opening a canvas or a page that shows one tells the
image's host the reader's address and when they looked, and a page's script can encode what it holds
into an image URL it builds. `connect-src 'none'` still stops every other way out.

A page previewed from the host also loads its own folder's files — scripts, styles, images and fonts
under it, never above it — through a folder-signed route; that is
[ADR 0135](0135-a-previewed-page-loads-its-own-folders-files.md). A canvas loads none.
