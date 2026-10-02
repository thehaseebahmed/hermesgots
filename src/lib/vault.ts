import { isNative } from "@/lib/native"

/**
 * End-to-end encryption for sync. One random data key encrypts everything Memento uploads; the
 * server only ever holds that key wrapped by secrets it never sees: a passkey's PRF output or a
 * recovery code. Web Crypto only.
 */

/** Stored on the server as-is. Every byte field is base64. */
export interface Vault {
  v: 1
  /** Shared PRF input for every passkey; each credential still derives its own secret from it. */
  prfSalt: string
  wrappers: Wrapper[]
}

export type Wrapper =
  | { kind: "passkey"; credentialId: string; iv: string; wrapped: string }
  | { kind: "recovery"; salt: string; iv: string; wrapped: string }

/** An encrypted document as stored on the server. */
export interface Sealed {
  v: 1
  iv: string
  ct: string
}

export class PrfUnsupportedError extends Error {
  constructor() {
    super("This passkey can't be used for encryption.")
    this.name = "PrfUnsupportedError"
  }
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()
const RECOVERY_ITERATIONS = 310_000
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

export function toBase64(bytes: ArrayBuffer | Uint8Array) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let binary = ""
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export function fromBase64(text: string) {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function random(length: number) {
  return crypto.getRandomValues(new Uint8Array(length))
}

/** A fresh data key. Extractable only so it can be wrapped; devices keep a non-extractable copy. */
export function generateDataKey() {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"])
}

async function wrap(dataKey: CryptoKey, wrappingKey: CryptoKey) {
  const iv = random(12)
  const wrapped = await crypto.subtle.wrapKey("raw", dataKey, wrappingKey, { name: "AES-GCM", iv })
  return { iv: toBase64(iv), wrapped: toBase64(wrapped) }
}

function unwrap(wrapper: Wrapper, wrappingKey: CryptoKey, extractable: boolean) {
  return crypto.subtle.unwrapKey(
    "raw",
    fromBase64(wrapper.wrapped),
    wrappingKey,
    { name: "AES-GCM", iv: fromBase64(wrapper.iv) },
    { name: "AES-GCM" },
    extractable,
    ["encrypt", "decrypt"],
  )
}

/** The non-extractable copy a device keeps, so its script can use the key but never read it. */
export async function lockDown(dataKey: CryptoKey) {
  if (!dataKey.extractable) return dataKey
  const raw = await crypto.subtle.exportKey("raw", dataKey)
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"])
}

export async function seal(key: CryptoKey, value: unknown, aad: string): Promise<Sealed> {
  const iv = random(12)
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(aad) },
    key,
    encoder.encode(JSON.stringify(value)),
  )
  return { v: 1, iv: toBase64(iv), ct: toBase64(ct) }
}

/** Throws if the document was tampered with or sealed for a different `aad`. */
export async function unseal<T>(key: CryptoKey, sealed: Sealed, aad: string): Promise<T> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromBase64(sealed.iv), additionalData: encoder.encode(aad) },
    key,
    fromBase64(sealed.ct),
  )
  return JSON.parse(decoder.decode(plain)) as T
}

// Recovery code: 125 random bits as 25 Crockford base32 characters, shown in five groups of five.

export function newRecoveryCode() {
  const bytes = random(16)
  let bits = 0
  let value = 0
  let code = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5 && code.length < 25) {
      code += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return code.match(/.{1,5}/g)!.join("-")
}

/** Accepts the code however it was retyped: any case, spacing, and the usual look-alikes. */
export function normalizeRecoveryCode(input: string) {
  return input
    .toUpperCase()
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    .replace(/[^0-9A-Z]/g, "")
}

async function recoveryKey(code: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(normalizeRecoveryCode(code)),
    "PBKDF2",
    false,
    ["deriveKey"],
  )
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: RECOVERY_ITERATIONS },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  )
}

export async function recoveryWrapper(dataKey: CryptoKey, code: string): Promise<Wrapper> {
  const salt = random(16)
  return {
    kind: "recovery",
    salt: toBase64(salt),
    ...(await wrap(dataKey, await recoveryKey(code, salt))),
  }
}

/** Unwraps with a recovery code. Throws if the code is wrong. */
export async function unlockWithRecoveryCode(vault: Vault, code: string) {
  for (const wrapper of vault.wrappers) {
    if (wrapper.kind !== "recovery") continue
    try {
      return await unwrap(wrapper, await recoveryKey(code, fromBase64(wrapper.salt)), true)
    } catch {
      // Try the next recovery wrapper, if there is one.
    }
  }
  throw new Error("That recovery code doesn't match.")
}

// Passkeys: the WebAuthn PRF extension turns a passkey into a stable 32-byte secret.

async function prfKey(secret: BufferSource, prfSalt: string) {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey"])
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: fromBase64(prfSalt),
      info: encoder.encode("memento-vault-v1"),
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"],
  )
}

async function assertPasskey(prfSalt: string, credentialIds: string[]) {
  const credential = (await navigator.credentials.get({
    publicKey: {
      challenge: random(32),
      allowCredentials: credentialIds.map((id) => ({ type: "public-key", id: fromBase64(id) })),
      userVerification: "required",
      extensions: { prf: { eval: { first: fromBase64(prfSalt) } } },
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error("No passkey was chosen.")
  const secret = credential.getClientExtensionResults().prf?.results?.first
  if (!secret) throw new PrfUnsupportedError()
  return { credentialId: toBase64(credential.rawId), secret }
}

export function newVault(): Vault {
  return { v: 1, prfSalt: toBase64(random(32)), wrappers: [] }
}

export function supportsPasskeys() {
  // The app's WebView runs on `https://localhost`, which can't use the deploy's passkeys.
  return !isNative && typeof window !== "undefined" && "PublicKeyCredential" in window
}

/** Registers a passkey and wraps the data key with its PRF secret. */
export async function passkeyWrapper(
  dataKey: CryptoKey,
  vault: Vault,
  user: { id: string; name: string; displayName: string },
): Promise<Wrapper> {
  if (!supportsPasskeys()) throw new PrfUnsupportedError()
  const credential = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "Memento" },
      user: { id: encoder.encode(user.id), name: user.name, displayName: user.displayName },
      challenge: random(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
      excludeCredentials: vault.wrappers
        .filter((w) => w.kind === "passkey")
        .map((w) => ({ type: "public-key", id: fromBase64(w.credentialId) })),
      extensions: { prf: { eval: { first: fromBase64(vault.prfSalt) } } },
    },
  })) as PublicKeyCredential | null
  if (!credential) throw new Error("No passkey was created.")
  const prf = credential.getClientExtensionResults().prf
  if (!prf?.enabled) throw new PrfUnsupportedError()
  const credentialId = toBase64(credential.rawId)
  // Many authenticators only evaluate PRF on sign-in, so ask once more when creation didn't.
  const secret = prf.results?.first ?? (await assertPasskey(vault.prfSalt, [credentialId])).secret
  return {
    kind: "passkey",
    credentialId,
    ...(await wrap(dataKey, await prfKey(secret, vault.prfSalt))),
  }
}

export function hasPasskeys(vault: Vault) {
  return vault.wrappers.some((w) => w.kind === "passkey")
}

/** Unwraps with any of the vault's passkeys. */
export async function unlockWithPasskey(vault: Vault) {
  const passkeys = vault.wrappers.filter((w) => w.kind === "passkey")
  const { credentialId, secret } = await assertPasskey(
    vault.prfSalt,
    passkeys.map((w) => w.credentialId),
  )
  const wrapper = passkeys.find((w) => w.credentialId === credentialId)
  if (!wrapper) throw new Error("That passkey isn't set up for Memento.")
  return unwrap(wrapper, await prfKey(secret, vault.prfSalt), true)
}
