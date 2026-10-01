import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { ThemeProvider } from "next-themes"
import { BrowserRouter } from "react-router"

import App from "@/App"
import { Toaster } from "@/components/ui/sonner"
import { recoverInterruptedMessages } from "@/lib/chat"
import "@/index.css"

void recoverInterruptedMessages()

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
