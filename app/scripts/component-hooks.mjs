/**
 * The component tier's environment: a DOM, an IndexedDB and the app's own aliases, before any test
 * file loads.
 *
 * `node --test --import ./scripts/component-hooks.mjs scripts/test-*.tsx` gives a test file the
 * globals a screen needs — React renders into a real `document`, Dexie finds an `indexedDB` — and
 * `component-loader.mjs` transforms the app's TypeScript and TSX through Vite's own esbuild, so a
 * test imports `@/components/afk` exactly as the app does. What it does not give it is a browser:
 * there is no layout, so nothing here can measure a sheet's height (ADR 0019 sends that to the
 * sweep).
 */
import { JSDOM } from "jsdom"
import "fake-indexeddb/auto"
import { register } from "node:module"

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost:3000/",
  pretendToBeVisual: true,
})

const globals = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  location: dom.window.location,
  history: dom.window.history,
  localStorage: dom.window.localStorage,
  sessionStorage: dom.window.sessionStorage,
  HTMLElement: dom.window.HTMLElement,
  HTMLInputElement: dom.window.HTMLInputElement,
  HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
  Element: dom.window.Element,
  Node: dom.window.Node,
  Event: dom.window.Event,
  CustomEvent: dom.window.CustomEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MouseEvent: dom.window.MouseEvent,
  DOMParser: dom.window.DOMParser,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  requestAnimationFrame: (callback) => setTimeout(() => callback(Date.now()), 0),
  cancelAnimationFrame: (handle) => clearTimeout(handle),
  // jsdom has no layout, so the only width a screen can ask about is the window's: a `min-width`
  // query answers from it (read live, since a module keeps a list per query), and anything else
  // reads as off — a phone with no hover and no reduced-motion preference. The motion preference is
  // the environment's, so a test flips it where it is read rather than in `matchMedia`: a list made
  // earlier would never be asked again.
  matchMedia: (query) => {
    const min = /\(min-width:\s*(\d+)px\)/.exec(query)
    const motion = query.includes("prefers-reduced-motion")
    return {
      get matches() {
        if (motion) return Boolean(globalThis.__reducedMotion)
        return min ? dom.window.innerWidth >= Number(min[1]) : false
      },
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }
  },
}

for (const [name, value] of Object.entries(globals))
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })

// React 19 asks for this before it will run a commit outside an event.
globalThis.IS_REACT_ACT_ENVIRONMENT = true

// `import.meta.env`, as the build's define hands it to a module (see `component-loader.mjs`).
globalThis.__HERMES_ENV__ = {
  DEV: false,
  PROD: true,
  MODE: "test",
  BASE_URL: "/",
  VITE_SITE_URL: "",
  VITE_FIREBASE: undefined,
}

// The screens under test draw a sheet only where the viewport is a phone's: jsdom has no layout,
// so the width is the one a phone reports, and a test that needs a tablet sets it itself.
Object.defineProperty(dom.window, "innerWidth", { value: 390, writable: true, configurable: true })
Object.defineProperty(dom.window, "innerHeight", { value: 844, writable: true, configurable: true })

/**
 * jsdom has no layout, so a box reports no size and a `ResizeObserver` is never called. The stub
 * records the observers a screen made, and `resized()` in the kit fires them, so a test can hand a
 * measuring component the sizes a browser would have reported.
 */
const observers = []
globalThis.__resizeObservers = observers

class ResizeObserver {
  constructor(callback) {
    this.callback = callback
    this.watching = []
    observers.push(this)
  }
  observe(target) {
    this.watching.push(target)
  }
  unobserve(target) {
    this.watching = this.watching.filter((one) => one !== target)
  }
  disconnect() {
    this.watching = []
  }
  report() {
    if (this.watching.length) this.callback([], this)
  }
}

Object.defineProperty(globalThis, "ResizeObserver", {
  value: ResizeObserver,
  writable: true,
  configurable: true,
})

dom.window.ResizeObserver = ResizeObserver
dom.window.matchMedia = globals.matchMedia
dom.window.HTMLElement.prototype.scrollIntoView = () => {}
dom.window.HTMLElement.prototype.setPointerCapture = () => {}
dom.window.HTMLElement.prototype.releasePointerCapture = () => {}
dom.window.HTMLElement.prototype.hasPointerCapture = () => false
// jsdom implements no Web Animations, and the shell's panes ask an element to animate as they open.
dom.window.HTMLElement.prototype.animate = () => ({
  finished: Promise.resolve(),
  cancel() {},
  finish() {},
  play() {},
  pause() {},
})

const canvas2d = {
  measureText: (text) => ({ width: Math.ceil(String(text).length * 8) }),
}
const canvas = dom.window.HTMLCanvasElement.prototype
// The stub is installed once per realm: a second pass would wrap the stub in itself, so the flag
// lives here rather than on the method the stub replaces.
let canvasStubbed = false
function stubCanvas() {
  if (canvasStubbed) return
  canvasStubbed = true
  canvas.getContext = () => canvas2d
}
stubCanvas()

register("./component-loader.mjs", import.meta.url)
