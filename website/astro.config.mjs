import react from "@astrojs/react"
import { defineConfig } from "astro/config"

export default defineConfig({
  site: "https://hermesgots.dev",
  output: "static",
  // React only for the hero's drawn product scene (stageshow); the rest of the site stays static
  integrations: [react()],
})
