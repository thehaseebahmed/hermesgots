import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"
import { BrowserRouter } from "react-router"

import App from "@/App"
import { PushLinks } from "@/routes/open-session"
import { CrashBoundary } from "@/components/crash-screen"
import { Toaster } from "@/components/ui/sonner"
import { recoverInterruptedMessages } from "@/lib/chat"
import { handBackNativeSignIn, handleBackButton } from "@/lib/native"
import { startLive } from "@/lib/live"
import { startPush } from "@/lib/push"
import { startSync } from "@/lib/sync"
import { watchToastOffset } from "@/lib/toast"
import "@/index.css"

if (!handBackNativeSignIn()) {
  handleBackButton()
  watchToastOffset()
  void recoverInterruptedMessages()
  void startSync()
  startLive()
  startPush()
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
      <CrashBoundary>
        <BrowserRouter>
          <App />
          <PushLinks />
        </BrowserRouter>
      </CrashBoundary>
      <Toaster
        position="bottom-center"
        offset={{ bottom: "var(--toast-bottom)" }}
        mobileOffset={{ bottom: "var(--toast-bottom)" }}
        // The sidebar width changes with the user's preference.
        className="toaster group md:ml-[calc(var(--sidebar-width)/2)]!"
      />
    </ThemeProvider>
  </StrictMode>,
)
