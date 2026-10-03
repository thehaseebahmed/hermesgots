import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "app.memento",
  appName: "Memento",
  webDir: "dist",
  android: {
    // Hermes often runs on a LAN or Tailscale host over plain HTTP.
    allowMixedContent: true,
  },
}

export default config
