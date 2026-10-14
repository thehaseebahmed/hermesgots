import { isNative } from "@/lib/native"

/**
 * End-to-end encryption for sync. One random data key encrypts everything Gots uploads; the
 * server only ever holds that key wrapped by secrets it never sees: a passkey's PRF output or a
 * recovery code. Web Crypto only.
 */

/** Stored on the server as-is. Every byte field is base64. */
export interface Vault {
  v: 1
  /** Shared PRF input for every passkey; each credential still derives its own secret from it. */
  prfSalt: string
  wrappers: Wrapper[]
  /** Added on the first unlock after it shipped, so older vaults lack it until then. */
  inbox?: Inbox
}

/**
 * The account's inbox: Gots plugins seal their bot records to its public half, so the registry
 * passes along URLs and API keys it can't read. The private half is sealed with the data key.
 */
export interface Inbox {
  /** Hex of the first 8 bytes of the public key's SHA-256; a link code carries the same bytes. */
  keyId: string
  /** P-256, SPKI DER, base64. */
  publicKey: string
  /** PKCS #8, base64, sealed for `memento:<userId>:inbox`. */
  privateKey: Sealed
}

/** A record sealed to the inbox: an ephemeral P-256 key, ECDH, HKDF-SHA256 and AES-256-GCM. */
export interface SealedToInbox {
  v: 1
  /** The ephemeral public key, uncompressed point, base64. */
  epk: string
  iv: string
  ct: string
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

/** Crockford base32, most significant bit first, the last character padded with zero bits. */
export function toBase32(bytes: Uint8Array, length = Math.ceil((bytes.length * 8) / 5)) {
  let bits = 0
  let value = 0
  let code = ""
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5 && code.length < length) {
      code += CROCKFORD[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0 && code.length < length) code += CROCKFORD[(value << (5 - bits)) & 31]
  return code
}

// Recovery code: 125 random bits as 25 Crockford base32 characters, shown in five groups of five.

export function newRecoveryCode() {
  return toBase32(random(16), 25)
    .match(/.{1,5}/g)!
    .join("-")
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
      rp: { name: "Gots" },
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
  if (!wrapper) throw new Error("That passkey isn't set up for Gots.")
  return unwrap(wrapper, await prfKey(secret, vault.prfSalt), true)
}

// Inbox: plugins seal bot records to the account's public key (see `Inbox`).

const INBOX_KEY = { name: "ECDH", namedCurve: "P-256" } as const

/** The first 8 bytes of the public key's SHA-256: the key id, and the fingerprint in link codes. */
export async function inboxFingerprint(publicKey: string) {
  const digest = await crypto.subtle.digest("SHA-256", fromBase64(publicKey))
  return new Uint8Array(digest).slice(0, 8)
}

function hex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** A new inbox, and this device's non-extractable copy of its private key. */
export async function newInbox(dataKey: CryptoKey, aad: string) {
  const pair = (await crypto.subtle.generateKey(INBOX_KEY, true, ["deriveBits"])) as CryptoKeyPair
  const publicKey = toBase64(await crypto.subtle.exportKey("spki", pair.publicKey))
  const pkcs8 = toBase64(await crypto.subtle.exportKey("pkcs8", pair.privateKey))
  const inbox: Inbox = {
    keyId: hex(await inboxFingerprint(publicKey)),
    publicKey,
    privateKey: await seal(dataKey, pkcs8, aad),
  }
  return { inbox, privateKey: await importInboxKey(pkcs8) }
}

function importInboxKey(pkcs8: string) {
  return crypto.subtle.importKey("pkcs8", fromBase64(pkcs8), INBOX_KEY, false, ["deriveBits"])
}

/** Throws if the inbox was tampered with or sealed for a different `aad`. */
export async function openInbox(dataKey: CryptoKey, inbox: Inbox, aad: string) {
  return importInboxKey(await unseal<string>(dataKey, inbox.privateKey, aad))
}

/** Opens a record a plugin sealed to the inbox. Throws if it was tampered with or misaddressed. */
export async function openFromInbox<T>(
  privateKey: CryptoKey,
  sealed: SealedToInbox,
  aad: string,
): Promise<T> {
  const epk = fromBase64(sealed.epk)
  const ephemeral = await crypto.subtle.importKey("raw", epk, INBOX_KEY, false, [])
  const shared = await crypto.subtle.deriveBits(
    { name: "ECDH", public: ephemeral },
    privateKey,
    256,
  )
  const material = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveKey"])
  const key = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: epk, info: encoder.encode("memento-inbox-v1") },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  )
  return unseal<T>(key, { v: 1, iv: sealed.iv, ct: sealed.ct }, aad)
}
