import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"
import { BrowserRouter } from "react-router"

import App from "@/App"
import { Toaster } from "@/components/ui/sonner"
import { recoverInterruptedMessages } from "@/lib/chat"
import { EXIT_TOASTER, handBackNativeSignIn, handleBackButton } from "@/lib/native"
import { startLive } from "@/lib/live"
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
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      // The provider's anti-flash script only runs when server-rendered; as a data block React
      // doesn't warn about it.
      scriptProps={{ type: "application/json" }}
    >
      <BrowserRouter>
        <App />
      </BrowserRouter>
      <Toaster position="top-center" />
      <Toaster
        id={EXIT_TOASTER}
        position="bottom-center"
        offset={{ bottom: "var(--exit-toast-bottom)" }}
        mobileOffset={{ bottom: "var(--exit-toast-bottom)" }}
        // Centred on the screen rather than the window, past the sidebar (w-72, lg:w-80).
        className="toaster group md:ml-36! lg:ml-40!"
      />
    </ThemeProvider>
  </StrictMode>,
)
