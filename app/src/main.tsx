import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"
import { BrowserRouter } from "react-router"

import App from "@/App"
import { Toaster } from "@/components/ui/sonner"
import { recoverInterruptedMessages } from "@/lib/chat"
import { startLive } from "@/lib/live"
import { handBackNativeSignIn, handleBackButton } from "@/lib/native"
import { startSync } from "@/lib/sync"
import "@/index.css"

if (!handBackNativeSignIn()) {
  handleBackButton()
  void recoverInterruptedMessages()
  void startSync()
  startLive()
}

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
