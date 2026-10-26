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
import { startResumeTrace } from "@/lib/resume-trace"
import { startSync } from "@/lib/sync"
import { watchToastOffset } from "@/lib/toast"
import { onReturn } from "@/lib/wake"
import "@/index.css"

if (!handBackNativeSignIn()) {
  handleBackButton()
  watchToastOffset()
  void recoverInterruptedMessages()
  void startSync()
  startLive()
  startPush()
  // Every return to the foreground begins the trace the resume stages mark.
  onReturn(startResumeTrace)
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
        // Centred on the screen rather than the window, past the sidebar (w-72, lg:w-80).
        className="toaster group md:ml-36! lg:ml-40!"
      />
    </ThemeProvider>
  </StrictMode>,
)
