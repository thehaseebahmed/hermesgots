import { Capacitor } from "@capacitor/core"

/** Whether this is the Android app, where the page is served from `https://localhost`. */
export const isNative = () => Capacitor.isNativePlatform()
