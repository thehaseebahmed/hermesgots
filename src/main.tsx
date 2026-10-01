import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"
import { BrowserRouter } from "react-router"

import App from "@/App"
import { Toaster } from "@/components/ui/sonner"
import { recoverInterruptedMessages } from "@/lib/chat"
import { db } from "@/lib/db"
import "@/index.css"

void recoverInterruptedMessages()

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !db.isOpen()) db.open().catch(console.error)
})

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster position="top-center" />
    </ThemeProvider>
  </StrictMode>,
)
