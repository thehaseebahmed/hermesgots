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
  matchMedia: (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  }),
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

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
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

register("./component-loader.mjs", import.meta.url)
