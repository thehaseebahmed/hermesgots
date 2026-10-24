# Attachments reach the agent as host paths, not as provider uploads

A message's attachments travel in two halves. The bytes are POSTed to the Gots plugin's attachment
route on the host, which writes them under the session; the model receives a marker line naming the
file, its type and its path, plus one sentence saying the content is not inlined and that it should
extract the text itself. Images are the exception that proves the shape: they also go inline as a
scaled `image_url` part, because that is the one content type every provider takes natively.

The split is forced by the platform rather than chosen for taste. Hermes's API server caps any
request at 10 MB (`MAX_REQUEST_BYTES`), and that cap bounds the whole JSON envelope — base64
inflates by a third, so nothing near the cap can be inlined as a part anyway. Its content parts are
`text` and `image_url` only: `file`, `input_file`, `document`, `audio` and `video` are rejected
outright. `/v1/runs` passes an unknown part through unvalidated, but the Anthropic converter handles
text and images and leaves anything else for the provider to refuse — so an inline upload for a
non-image is not a path that works slowly, it is no path at all. The host path is the only channel
that carries every type the phone can hold, and the agent's own tools — `read_file`, `pdftotext`,
the OCR skill — are what turn that path into content when the agent needs it.

## Considered options

- **Chunked upload through the plugin, ceiling raised to 200 MB.** Would let a phone video or a
  large archive ride up whole, and the plugin could append chunks to one file. Rejected: big media
  is the rare case, resumable upload is a protocol both sides have to speak, and a 9 MB per-file cap
  with a clear refusal at pick time keeps the intake rule to one number enforced in one place.
- **Convert on the way in** — transcribe audio, extract document text on the host, and send the
  result as text beside the marker. Rejected: it spends a model on every attachment, it does the
  work before the agent knows whether it wants it, and it puts a conversion between the user and
  their file for the common case where the agent only needs to know the file exists.
- **Refuse every type with no native part.** Rejected: that is images and nothing else, and the
  path channel already carries documents, code, archives and binaries without strain.

## Consequences

- **The marker line is the contract**, not an implementation detail: `<attachment name type size path>`
  plus the instruction sentence, once in every message that carries a file. A steer may carry it
  because a steer is text; a message carrying inline images queues instead, because a steer cannot.
- **The thread renders from the host path.** A device that synced or restored a chat sees the real
  media through the plugin's media route rather than a name and a size of zero; the only bytes the
  device keeps are a local cache of its own images.
- **9 MB is the API server's number, not Gots's.** Raising the ceiling means chunked upload, which
  is the option that was declined here.
- **The route must serve every type, not just raster.** The media route widens past images, sends a
  content type for audio, video, documents and archives, and marks anything the thread cannot show
  as a download — otherwise a path the model was given is a path the thread cannot draw.
