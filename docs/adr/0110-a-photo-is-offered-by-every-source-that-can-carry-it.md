# A photo is offered by every source that can carry it, inline or as a host path

Camera and Photos were offered only when the bot's model reads images, because the inline `image_url` part
was the only road a photo had. Files was offered whenever the plugin's upload route answered, and the same
photo picked there reached the agent as a path on the host. A bot whose model reads no images therefore
refused a photo at the sheet while accepting it through Files, one tap away.

A photo now has two roads, and a source is offered when either is open: the model reads images, so the bytes
ride inline, or the plugin's route saves the file, so the bytes ride as a path the agent's own tools open. A
photo the browser can decode is scaled to fit the 9 MB per-file cap rather than refused, because a camera
photo is routinely past it and a vision tool reads a 1600px copy as well as the original. Where the host has
answered that it has no route and the model reads no images, no road exists, and the sheet says so above the
sources; while the answer is unknown, the sources are offered and the send is where a failure is spoken.

## Considered options

- **Refusing the two sources as before, and leaving the user to pick the photo through Files.** Rejected: the
  same tap already works, so the sheet was refusing something the app could do.
- **Always sending a photo as a file.** Rejected: inline is the one content type every provider takes, and
  the model reads the image on the turn it was sent instead of opening a path with a tool.
- **Keeping a photo over the cap refused on the file road.** Rejected: that leaves a modern camera's photo
  failing exactly where this change promised it would not, and the scaled copy already exists.
- **Refusing the sources while the host's answer is unknown.** Rejected: an answer not read yet is not a no,
  and a failure at send names the file and the reason.

## Consequences

- The sheet's promise and the composer's intake ask one rule, so they cannot disagree about the same photo.
- `Attachment.image` means the file is a picture; whether the model is sent its bytes is the presence of the
  inline part, and stored rows are folded to match.
- A photo on the file road costs an upload, and a host that advertises the route and then refuses the file
  refuses the whole message where an inline photo would have gone.
