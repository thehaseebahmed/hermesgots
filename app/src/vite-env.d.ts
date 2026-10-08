/// <reference types="vite/client" />

/** `<package version> · <short commit>`, baked in at build time. */
declare const __APP_VERSION__: string
declare const __BUILD_TIME__: string

interface ImportMetaEnv {
  readonly VITE_SITE_URL?: string
  readonly VITE_FIREBASE?: string
}
