/**
 * The one door between a canvas's page and the app (ADR 0114).
 *
 * The page is drawn in a frame with an opaque origin, so it reaches nothing of the app's and the
 * parent is its only door. Reads are answered from this device's copy of the canvas's data — the
 * copy a read of the canvas carries — so a page opens and lists what it holds with the host away
 * (ADR 0113); writes go to the host's one route, `POST canvases/<id>/call`, and the answer it
 * gives is what the copy keeps.
 *
 * Import-free, so `scripts/test-canvas-bridge.mjs` runs it as a pure rule.
 */

/** The name both halves mark a message with, so the page and the app agree on one shape. */
export const BRIDGE_MESSAGE = "gots:canvas-data"

/** One document of a canvas's own data, as the host answers it: a collection, an id and a clock. */
export interface CanvasDoc {
  collection: string
  id: string
  doc: unknown
  at: number
}

/** What every call carries: the number its reply names it by, and the page that asked. */
interface BridgeCallBase {
  call: number
  /** The document that asked, so a reply can only settle a call of the page it answers. */
  epoch?: string
}

/** A call the page made, as the app reads it off a message. */
export type BridgeCall =
  | (BridgeCallBase & { method: "list"; collection: string })
  | (BridgeCallBase & { method: "get"; collection: string; id: string })
  | (BridgeCallBase & { method: "put"; collection: string; id: string; doc: unknown })
  | (BridgeCallBase & { method: "remove"; collection: string; id: string })

/** A call the host answers: a read is the device's copy's, and never reaches it. */
export type BridgeWriteCall = Extract<BridgeCall, { method: "put" | "remove" }>

/**
 * A call the page sent, or null for anything else. Another window's idea of the message is not a
 * call: the type, the number, the collection and the fields each method needs all have to be here.
 */
export function readCall(data: unknown): BridgeCall | null {
  if (!data || typeof data !== "object") return null
  const raw = data as Record<string, unknown>
  if (raw.type !== BRIDGE_MESSAGE) return null
  if (typeof raw.call !== "number" || !Number.isInteger(raw.call) || raw.call <= 0) return null
  const epoch = typeof raw.epoch === "string" && raw.epoch ? { epoch: raw.epoch } : {}
  const method = raw.method
  if (method !== "list" && method !== "get" && method !== "put" && method !== "remove") return null
  if (typeof raw.collection !== "string" || !raw.collection) return null
  if (method === "list") return { ...epoch, call: raw.call, method, collection: raw.collection }
  if (typeof raw.id !== "string" || !raw.id) return null
  if (method === "put") {
    // The key decides, not what it holds: a stored null is a value the page wrote.
    if (!("doc" in raw)) return null
    return { ...epoch, call: raw.call, method, collection: raw.collection, id: raw.id, doc: raw.doc }
  }
  return { ...epoch, call: raw.call, method, collection: raw.collection, id: raw.id }
}

/**
 * What a read answers, from the device's copy alone: the collection's documents in copy order, or
 * the one document, or null. No read reaches the host.
 */
export function answerRead(call: BridgeCall, copy: CanvasDoc[]): unknown {
  if (call.method === "list") return copy.filter((row) => row.collection === call.collection)
  return copy.find((row) => row.collection === call.collection && row.id === call.id) ?? null
}

/** A document the host answered with, or null when the answer isn't the shape it documents. */
export function storedDoc(value: unknown): CanvasDoc | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.collection !== "string" || !raw.collection) return null
  if (typeof raw.id !== "string" || !raw.id) return null
  if (typeof raw.at !== "number") return null
  if (!("doc" in raw)) return null
  return { collection: raw.collection, id: raw.id, doc: raw.doc, at: raw.at }
}

/**
 * The host's own order, by the host's own comparison: `ORDER BY collection, id` compares UTF-8
 * bytes, which is code-point order, and JavaScript's `<` compares UTF-16 units — so a name outside
 * the BMP (an emoji, say) would sort on the other side of a BMP name in a copy the app sorted with
 * `<` alone. `byCodePoint` is the comparison both sides agree on.
 */
function byCodePoint(a: string, b: string): number {
  const left = [...a]
  const right = [...b]
  for (let at = 0; at < Math.min(left.length, right.length); at += 1) {
    const one = left[at].codePointAt(0) ?? 0
    const other = right[at].codePointAt(0) ?? 0
    if (one !== other) return one < other ? -1 : 1
  }
  return left.length - right.length
}

export function inOrder(copy: CanvasDoc[]): CanvasDoc[] {
  return [...copy].sort((a, b) => byCodePoint(a.collection, b.collection) || byCodePoint(a.id, b.id))
}

/**
 * The copy after a host write, or null for an answer that isn't the shape the host documents. A put
 * replaces or inserts the document the host answered with — unless the copy already holds a newer
 * one, since two writes' answers can land out of order — a remove drops the one it named, and either
 * answer is a new array in the host's own order.
 */
export function applyWrite(
  copy: CanvasDoc[],
  call: BridgeWriteCall,
  value: unknown,
): CanvasDoc[] | null {
  if (!value || typeof value !== "object") return null
  if (call.method === "remove") {
    const raw = value as Record<string, unknown>
    if (typeof raw.collection !== "string" || typeof raw.id !== "string") return null
    if (typeof raw.removed !== "boolean") return null
    return inOrder(copy.filter((row) => row.collection !== raw.collection || row.id !== raw.id))
  }
  const stored = storedDoc(value)
  if (!stored) return null
  const held = copy.find((row) => row.collection === stored.collection && row.id === stored.id)
  // The host's clock says which of two writes to one document it kept: a slower answer must not
  // put the page back on the document the faster one replaced.
  if (held && held.at > stored.at) return copy
  const kept = copy.filter((row) => row.collection !== stored.collection || row.id !== stored.id)
  return inOrder([...kept, stored])
}

/**
 * The page's half, put in the head ahead of the page's own scripts: `window.canvas.data` with
 * `list`, `get`, `put` and `remove`, each posting the call to the parent and settling on the reply
 * that names it. Every message carries this document's own epoch, so a reply meant for the page
 * drawn before this one can never settle a promise here. ES5, like the scroll bridge beside it: it
 * runs before the page's own scripts and asks nothing of the page.
 */
export const BRIDGE_SCRIPT =
  `(function(){var TYPE="` +
  BRIDGE_MESSAGE +
  `";var EPOCH=Math.random().toString(36).slice(2);var waiting={};var calls=0;var send=function(method,collection,id,doc){var call=++calls;return new Promise(function(resolve,reject){waiting[call]={resolve:resolve,reject:reject};var message={type:TYPE,epoch:EPOCH,call:call,method:method,collection:collection};if(id!==undefined){message.id=id}if(method==="put"){message.doc=doc}try{parent.postMessage(message,"*")}catch(e){delete waiting[call];reject(new Error("The canvas is not on the app's page."))}})};addEventListener("message",function(event){var data=event.data;if(!data||typeof data!=="object"||data.type!==TYPE||data.epoch!==EPOCH){return}var call=waiting[data.reply];if(!call){return}delete waiting[data.reply];if(data.ok){call.resolve(data.value)}else{call.reject(new Error(typeof data.error==="string"&&data.error?data.error:"The canvas's data didn't answer."))}});window.canvas={data:{list:function(collection){return send("list",collection)},get:function(collection,id){return send("get",collection,id)},put:function(collection,id,doc){return send("put",collection,id,doc)},remove:function(collection,id){return send("remove",collection,id)}}}})()`

/** What the parent's listener may ask of its world, so the rule itself holds no window or store. */
export interface BridgeHost {
  /** The frame as it is now: a message is heard only when this is its source. */
  frame(): Window | null
  /** The device's copy of the canvas's data, as the last read or write left it. */
  copy(): CanvasDoc[]
  /** A write through the host's route; its answer, or its error, is what the page is told. */
  write(call: BridgeWriteCall): Promise<unknown>
}

function wordsOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The parent's listener: a read is answered at once from the device's copy, and a write is the
 * host's, its answer posted when it settles. Nothing from another window is answered or posted —
 * a message is the canvas talking only when it comes from this screen's own frame — and a call this
 * rule cannot read is answered with the reason rather than dropped, since the page's promise is
 * waiting on it.
 */
export function bridgeHandler(host: BridgeHost): (event: MessageEvent) => void {
  return (event) => {
    const frame = host.frame()
    if (!frame || event.source !== frame) return
    const raw = event.data as Record<string, unknown> | null
    if (!raw || typeof raw !== "object" || raw.type !== BRIDGE_MESSAGE) return
    const reply = (call: number, ok: boolean, payload: Record<string, unknown>) =>
      frame.postMessage(
        {
          type: BRIDGE_MESSAGE,
          reply: call,
          ...(typeof raw.epoch === "string" ? { epoch: raw.epoch } : {}),
          ok,
          ...payload,
        },
        "*",
      )
    const call = readCall(raw)
    if (!call) {
      if (typeof raw.call === "number" && Number.isInteger(raw.call) && raw.call > 0) {
        reply(raw.call, false, {
          error: "A canvas's data call names a collection, and a document's id to read or write one.",
        })
      }
      return
    }
    if (call.method === "list" || call.method === "get") {
      reply(call.call, true, { value: answerRead(call, host.copy()) })
      return
    }
    void host.write(call).then(
      (value) => reply(call.call, true, { value }),
      (error: unknown) => reply(call.call, false, { error: wordsOf(error) }),
    )
  }
}
