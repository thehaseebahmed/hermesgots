import type { CapacitorConfig } from "@capacitor/cli"

const config: CapacitorConfig = {
  appId: "app.gots",
  appName: "Gots",
  webDir: "dist",
  android: {
    // Hermes often runs on a LAN or Tailscale host over plain HTTP.
    allowMixedContent: true,
  },
  plugins: {
    // Android shows a push in the tray even with the app open, which the test button relies on.
    PushNotifications: { presentationOptions: ["alert"] },
  },
}

export default config
