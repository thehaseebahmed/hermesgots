import type { Decorator, Preview } from "@storybook/react-vite"
import { useEffect } from "react"

import "../src/index.css"

/** The app's two modes are one class on the root, as next-themes sets it. */
const withMode: Decorator = function WithMode(Story, context) {
  const mode = context.globals.mode === "dark" ? "dark" : "light"
  useEffect(() => {
    document.documentElement.classList.toggle("dark", mode === "dark")
  }, [mode])
  return (
    <div className="bg-background p-4 text-foreground">
      <Story />
    </div>
  )
}

const preview: Preview = {
  decorators: [withMode],
  globalTypes: {
    mode: {
      description: "Colour mode",
      toolbar: {
        title: "Mode",
        icon: "circlehollow",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { mode: "light" },
  parameters: {
    layout: "fullscreen",
    backgrounds: { disable: true },
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
}

export default preview
