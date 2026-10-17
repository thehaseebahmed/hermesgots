// Base64url helpers. No imports, so Node can load this file directly in scripts/ tests.

/** Bytes → base64url text, unpadded, as a JWT and a VAPID key are spelled. */
export function toBase64Url(bytes: ArrayBuffer | Uint8Array) {
  const array = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

/** base64url text → the bytes it carries. */
export function fromBase64Url(text: string) {
  const padded = text
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(text.length / 4) * 4, "=")
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0))
}
