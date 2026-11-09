/**
 * The one door between a canvas's page and the app (ADR 0114).
 *
 * The page is drawn in a frame with an opaque origin, so it reaches nothing of the app's and the
 * parent is its only door. Reads are answered from this device's copy of the canvas's data — the
 * copy a read of the canvas carries — so a page opens and lists what it holds with the host away
 * (ADR 0113); writes go to the host's one route, `POST canvases/<id>/call`, and the answer it
 * gives is what the copy keeps.
 *
 * Import-free but for the marker's own separator and the rule that cuts a label, so
 * `scripts/test-canvas-bridge.mjs` runs it as a pure rule.
 */

import { POINT_SELECTOR, type CanvasPoint } from "./point-marker.ts"
import { oneLine } from "./words.ts"

/** The name both halves mark a message with, so the page and the app agree on one shape. */
export const BRIDGE_MESSAGE = "gots:canvas-data"

/**
 * The name both halves mark a point with: the app tells the page a tap is a point, and the page answers
 * the element that was tapped, through the bridge ADR 0114 puts between the page and the app. A point
 * is not a call — nothing is awaited, and nothing but this screen's own frame is heard.
 */
export const POINT_MESSAGE = "gots:canvas-point"

/** How much of an element's own words a point carries: a chip, not a paragraph. */
export const POINT_LABEL_MAX = 80

/**
 * How long a selector may be. The page's own walk gives up long before this; one that arrives longer
 * was not written by that walk, and a selector cut short finds nothing, so the point is dropped.
 */
export const POINT_SELECTOR_MAX = 200

/**
 * What a page may ask of its data, in the order the page's half offers them: the same four names the
 * guide tells a bot it may call, held here so a guide that names a fifth is a failing test rather
 * than a promise the app doesn't keep.
 */
export const BRIDGE_METHODS = ["list", "get", "put", "remove"] as const

/**
 * The host's own reads a page may make without declaring anything (ADR 0114): what its bot's
 * account is using, the routines it keeps, its projects and the chats it holds. They read the
 * user's own things, which the user chose to leave open to every canvas the bot draws.
 */
export const CANVAS_READS = ["usage", "routines", "projects", "sessions"] as const

export type CanvasReadShape = (typeof CANVAS_READS)[number]

/**
 * The `code` a host's refusal carries when a page's tool was never allowed: the bridge asks the
 * reader about exactly this answer, and nothing else it refuses is a question for them.
 */
export const CANVAS_CONSENT_REQUIRED = "consent_required"

/**
 * The user's answer about one tool a canvas's page declared, as the host keeps it: `allowed` says
 * which way it went, and `at` is the host's clock for that answer. The clock is what lets a device
 * tell which of two answers it holds is the later one without comparing whole lists — a read that
 * began before a grant landed can't retract it.
 */
export interface CanvasGrant {
  tool: string
  allowed: boolean
  at: number
}

/**
 * Two copies of a canvas's answers as one: per tool the row the host stamped later, every tool
 * either side names, ordered by tool as the host orders them.
 *
 * The merge is what keeps a slow read from undoing the reader's answer: a read that began before
 * the grant was written answers without it, and its answer must not walk the answer back.
 */
export function mergeGrants(
  held: CanvasGrant[] | undefined,
  answer: CanvasGrant[] | undefined,
): CanvasGrant[] {
  const merged = new Map<string, CanvasGrant>()
  for (const row of [...(held ?? []), ...(answer ?? [])]) {
    const kept = merged.get(row.tool)
    if (!kept || row.at > kept.at) merged.set(row.tool, row)
  }
  return [...merged.values()].sort((one, other) => byCodePoint(one.tool, other.tool))
}

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
  | (BridgeCallBase & { method: "read"; shape: CanvasReadShape; args: Record<string, unknown> })
  | (BridgeCallBase & { method: "tool"; tool: string; args: Record<string, unknown> })

/** A call answered from this device's copy of the canvas's data: no other method reads it. */
export type BridgeDataCall = Extract<BridgeCall, { method: "list" | "get" | "put" | "remove" }>

/** A call the host answers: the canvas's own data, written through the host's one route. */
export type BridgeWriteCall = Extract<BridgeCall, { method: "put" | "remove" }>

/** A call that reaches the host: one of its free reads, or a declared tool the page calls. */
export type BridgeHostCall = Extract<BridgeCall, { method: "read" | "tool" }>

/** A host read's arguments: a named shape and whatever that shape takes. */
export type BridgeReadCall = Extract<BridgeCall, { method: "read" }>

/** A call to one of the bot's tools, as the version declared it. */
export type BridgeToolCall = Extract<BridgeCall, { method: "tool" }>

/** A tool's name is `<server>.<tool>`, and both halves have to be there. */
function namesTool(value: unknown): value is string {
  if (typeof value !== "string" || /\s/.test(value)) return false
  const dot = value.indexOf(".")
  return dot > 0 && dot < value.length - 1
}

/** A call's arguments: an object the method takes, or nothing at all. */
function argsOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * A call the page sent, or null for anything else. Another window's idea of the message is not a
 * call: the type, the number, the method and the fields each method needs all have to be here.
 */
export function readCall(data: unknown): BridgeCall | null {
  if (!data || typeof data !== "object") return null
  const raw = data as Record<string, unknown>
  if (raw.type !== BRIDGE_MESSAGE) return null
  if (typeof raw.call !== "number" || !Number.isInteger(raw.call) || raw.call <= 0) return null
  const epoch = typeof raw.epoch === "string" && raw.epoch ? { epoch: raw.epoch } : {}
  const method = raw.method
  if (method === "read") {
    if (typeof raw.shape !== "string" || !CANVAS_READS.includes(raw.shape as CanvasReadShape)) {
      return null
    }
    return {
      ...epoch,
      call: raw.call,
      method,
      shape: raw.shape as CanvasReadShape,
      args: argsOf(raw.args),
    }
  }
  if (method === "tool") {
    if (!namesTool(raw.tool)) return null
    return { ...epoch, call: raw.call, method, tool: raw.tool, args: argsOf(raw.args) }
  }
  if (method !== "list" && method !== "get" && method !== "put" && method !== "remove") return null
  if (typeof raw.collection !== "string" || !raw.collection) return null
  if (method === "list") return { ...epoch, call: raw.call, method, collection: raw.collection }
  if (typeof raw.id !== "string" || !raw.id) return null
  if (method === "put") {
    // The key decides, not what it holds: a stored null is a value the page wrote.
    if (!("doc" in raw)) return null
    return {
      ...epoch,
      call: raw.call,
      method,
      collection: raw.collection,
      id: raw.id,
      doc: raw.doc,
    }
  }
  return { ...epoch, call: raw.call, method, collection: raw.collection, id: raw.id }
}

/**
 * What a data read answers, from the device's copy alone: the collection's documents in copy order,
 * or the one document, or null. No data read reaches the host.
 */
export function answerRead(call: BridgeDataCall, copy: CanvasDoc[]): unknown {
  if (call.method === "list") return copy.filter((row) => row.collection === call.collection)
  if (call.method === "get")
    return copy.find((row) => row.collection === call.collection && row.id === call.id) ?? null
  return null
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
  return [...copy].sort(
    (a, b) => byCodePoint(a.collection, b.collection) || byCodePoint(a.id, b.id),
  )
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
 * What the app tells a page about pointing: whether a tap names an element right now. A page that is
 * let go stops highlighting and stops answering, and a tap is a tap again.
 */
export function pointWatch(watch: boolean): { type: typeof POINT_MESSAGE; watch: boolean } {
  return { type: POINT_MESSAGE, watch }
}

/**
 * The point a page answered, or null for anything else — another window's idea of the message, a point
 * with no words on it, or one with no selector to find it again. Both are clipped to one line, since
 * what a page says of an element can be a whole paragraph.
 */
export function readPoint(data: unknown): CanvasPoint | null {
  if (!data || typeof data !== "object") return null
  const raw = data as Record<string, unknown>
  if (raw.type !== POINT_MESSAGE) return null
  const point: unknown = raw.point
  if (!point || typeof point !== "object") return null
  const { label, selector } = point as { label?: unknown; selector?: unknown }
  const said = oneLine(typeof label === "string" ? label : "", POINT_LABEL_MAX)
  const found = oneLine(typeof selector === "string" ? selector : "")
  if (!said || !found) return null
  // A selector the page's own walk could not have written — too long, or carrying the marker's own
  // words, which would move the split the fold reads back — is no selector at all.
  if (found.length > POINT_SELECTOR_MAX || found.includes(POINT_SELECTOR)) return null
  return { label: said, selector: found }
}

/**
 * The page's half of pointing, put in the head beside the data bridge: the app says when a tap names an
 * element, a pointer over an element outlines it, and a tap answers the element's own words and a
 * selector that finds it — one id where it has one, else a class, else its place among its siblings,
 * under its parents. In the dialect the data bridge is written in, and it asks nothing of the page.
 */
export const POINT_SCRIPT = `(function(){
var TYPE="${POINT_MESSAGE}";
var MAX=${POINT_LABEL_MAX};
var watching=false;
var lit=null;
var prior=null;
function words(value){return String(value==null?"":value).replace(/\\s+/g," ").trim()}
function labelOf(el){
var said=words(el.getAttribute("aria-label")||el.getAttribute("alt")||el.getAttribute("title"));
if(said){return said.slice(0,MAX)}
var text=el.textContent;
if(text&&text.length>MAX*8){text=text.slice(0,MAX*8)}
text=words(text);
if(text){return text.slice(0,MAX)}
return el.id?"#"+el.id:el.tagName.toLowerCase()
}
function firstClass(el){
var held=el.getAttribute("class");
var name=words(held).split(" ")[0];
return name||""
}
function selectorOf(el,depth){
if(el.id){return "#"+el.id}
if(depth>6){return el.tagName.toLowerCase()}
var tag=el.tagName.toLowerCase();
var cls=firstClass(el);
var name=tag+(cls?"."+cls:"");
var index=1;
var sib=el.previousElementSibling;
while(sib){if(sib.tagName===el.tagName){index++}sib=sib.previousElementSibling}
if(index>1){name+=":nth-of-type("+index+")"}
var parent=el.parentElement;
if(!parent||parent===document.documentElement){return name}
return selectorOf(parent,(depth||0)+1)+" > "+name
}
function unmark(){
if(!lit){return}
lit.removeAttribute("data-gots-point");
if(prior){lit.style.outline=prior.outline;lit.style.outlineOffset=prior.offset;lit.style.cursor=prior.cursor}
lit=null;
prior=null
}
function mark(el){
if(!el||el.nodeType!==1||el===document.body||el===document.documentElement||el===lit){return}
unmark();
prior={outline:el.style.outline,offset:el.style.outlineOffset,cursor:el.style.cursor};
lit=el;
lit.setAttribute("data-gots-point","");
lit.style.outline="2px solid var(--primary, #6366f1)";
lit.style.outlineOffset="1px";
lit.style.cursor="crosshair"
}
function move(event){if(watching){mark(event.target)}}
function pick(event){
if(!watching){return}
var el=event.target;
if(!el||el.nodeType!==1){return}
event.preventDefault();
event.stopPropagation();
var point={label:labelOf(el),selector:selectorOf(el,0)};
try{parent.postMessage({type:TYPE,point:point},"*")}
catch(e){return}
watching=false;
unmark()
}
addEventListener("message",function(event){
var data=event.data;
if(!data||typeof data!=="object"||data.type!==TYPE){return}
watching=data.watch===true;
if(!watching){unmark()}
});
addEventListener("pointermove",move,true);
addEventListener("click",pick,true);
try{parent.postMessage({type:TYPE,ready:true},"*")}catch(e){}
})()`

/**
 * The page's half, put in the head ahead of the page's own scripts: `window.canvas.data` with
 * `list`, `get`, `put` and `remove`, `window.canvas.read(shape, args)` for the host's four free
 * reads, and `window.canvas.tool.call(name, args)` for a tool the version declared. Each posts the
 * call to the parent and settles on the reply that names it — a tool call waits on the reader's
 * answer, which the app keeps for it. Every message carries this document's own epoch, so a reply
 * meant for the page drawn before this one can never settle a promise here. ES5, like the scroll
 * bridge beside it: it runs before the page's own scripts and asks nothing of the page.
 */
export const BRIDGE_SCRIPT =
  `(function(){var TYPE="` +
  BRIDGE_MESSAGE +
  `";var EPOCH=Math.random().toString(36).slice(2);var waiting={};var calls=0;var ask=function(fields){var call=++calls;return new Promise(function(resolve,reject){waiting[call]={resolve:resolve,reject:reject};var message={type:TYPE,epoch:EPOCH,call:call};for(var key in fields){if(Object.prototype.hasOwnProperty.call(fields,key)){message[key]=fields[key]}}try{parent.postMessage(message,"*")}catch(e){delete waiting[call];reject(new Error("The canvas is not on the app's page."))}})};addEventListener("message",function(event){var data=event.data;if(!data||typeof data!=="object"||data.type!==TYPE||data.epoch!==EPOCH){return}var call=waiting[data.reply];if(!call){return}delete waiting[data.reply];if(data.ok){call.resolve(data.value)}else{call.reject(new Error(typeof data.error==="string"&&data.error?data.error:"The canvas's request didn't answer."))}});window.canvas={data:{list:function(collection){return ask({method:"list",collection:collection})},get:function(collection,id){return ask({method:"get",collection:collection,id:id})},put:function(collection,id,doc){return ask({method:"put",collection:collection,id:id,doc:doc})},remove:function(collection,id){return ask({method:"remove",collection:collection,id:id})}},read:function(shape,args){return ask({method:"read",shape:shape,args:args||{}})},tool:{call:function(name,args){return ask({method:"tool",tool:name,args:args||{}})}}}})()` +
  ";" +
  POINT_SCRIPT

/** What the parent's listener may ask of its world, so the rule itself holds no window or store. */
export interface BridgeHost {
  /** The frame as it is now: a message is heard only when this is its source. */
  frame(): Window | null
  /** The device's copy of the canvas's data, as the last read or write left it. */
  copy(): CanvasDoc[]
  /** A write through the host's route; its answer, or its error, is what the page is told. */
  write(call: BridgeWriteCall): Promise<unknown>
  /** A host read or a tool call; its answer, or its error, is what the page is told. */
  call(call: BridgeHostCall): Promise<unknown>
  /** Asks the reader whether the canvas may use one tool, and answers what they chose. */
  consent(tool: string): Promise<boolean>
  /** The element the page answered while a point was armed; a point is never a call. */
  point?(point: CanvasPoint): void
  /** A page that has just run its half of the bridge, and can be armed now. */
  ready?(): void
}

function wordsOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The `code` a refusal carries, where it carries one: a consent hold is decided by it. */
function codeOf(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === "string" ? code : undefined
}

/**
 * One ask per tool: the answer already out for `tool`, or a fresh one kept in `asking` until it
 * settles. A call that arrives while the dialog is up joins that answer instead of opening a
 * second dialog, and the entry goes when its own promise settles — never a later one's.
 */
function once(
  asking: Map<string, Promise<boolean>>,
  tool: string,
  ask: () => Promise<boolean>,
): Promise<boolean> {
  const owed = asking.get(tool)
  if (owed) return owed
  const answer = ask()
  asking.set(tool, answer)
  const clear = () => {
    if (asking.get(tool) === answer) asking.delete(tool)
  }
  void answer.then(clear, clear)
  return answer
}

/**
 * The parent's listener: a read of the canvas's data is answered at once from the device's copy, a
 * write is the host's, and a host read or a tool call is the host's too — a tool call held until the
 * reader allows it. Nothing from another window is answered or posted — a message is the canvas
 * talking only when it comes from this screen's own frame — and a call this rule cannot read is
 * answered with the reason rather than dropped, since the page's promise is waiting on it.
 *
 * A tool refused for consent is asked about once, however many calls are waiting on it: the second
 * call waits on the same answer rather than opening a second dialog. Allow retries the call once and
 * settles with that answer; Don't allow rejects the page's promise with a plain sentence. Any other
 * refusal is the host's own words, and is not something the reader can answer.
 */
export function bridgeHandler(host: BridgeHost): (event: MessageEvent) => void {
  const asking = new Map<string, Promise<boolean>>()
  const permission = (tool: string) => once(asking, tool, () => host.consent(tool))

  const callTool = async (call: BridgeToolCall): Promise<unknown> => {
    try {
      return await host.call(call)
    } catch (error) {
      if (codeOf(error) !== CANVAS_CONSENT_REQUIRED) throw error
      if (!(await permission(call.tool))) {
        throw new Error(`You didn't allow this canvas to use ${call.tool}.`)
      }
      // The reader said yes, so the grant is on the host now: the same call goes once more, and
      // that answer is the page's. A refusal here is the host's, not another dialog.
      return host.call(call)
    }
  }

  return (event) => {
    const frame = host.frame()
    if (!frame || event.source !== frame) return
    const raw = event.data as Record<string, unknown> | null
    if (!raw || typeof raw !== "object") return
    // A page says so once its own half is listening: an arm posted before that reaches a window with
    // nothing in it to hear.
    if (raw.type === POINT_MESSAGE && raw.ready === true) {
      host.ready?.()
      return
    }
    // A point is an answer, not a call: the page names the element it was tapped on, and nothing is
    // posted back to it.
    const point = readPoint(raw)
    if (point) {
      host.point?.(point)
      return
    }
    if (raw.type !== BRIDGE_MESSAGE) return
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
          error: "A canvas's call names a method, and the fields that method needs.",
        })
      }
      return
    }
    if (call.method === "list" || call.method === "get") {
      reply(call.call, true, { value: answerRead(call, host.copy()) })
      return
    }
    if (call.method === "put" || call.method === "remove") {
      void host.write(call).then(
        (value) => reply(call.call, true, { value }),
        (error: unknown) => reply(call.call, false, { error: wordsOf(error) }),
      )
      return
    }
    const asked = call.method === "tool" ? callTool(call) : host.call(call)
    void asked.then(
      (value) => reply(call.call, true, { value }),
      (error: unknown) => reply(call.call, false, { error: wordsOf(error) }),
    )
  }
}
