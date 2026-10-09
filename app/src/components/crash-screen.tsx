import { Component, useState, type ErrorInfo, type ReactNode } from "react"
import { CheckIcon, CopyIcon, MenuIcon, RotateCwIcon } from "lucide-react"

import { Bot } from "@/components/bot"
import { useOpenDrawer } from "@/components/drawer-context"
import { Button } from "@/components/ui/button"
import { forgetLastChat } from "@/lib/launch"

type Crash = { error: unknown; componentStack?: string | null }

function describe({ error, componentStack }: Crash) {
  const head =
    error instanceof Error
      ? (error.stack ?? `${error.name}: ${error.message}`)
      : `Thrown: ${String(error)}`
  return [
    `Memento v${__APP_VERSION__}`,
    new Date().toISOString(),
    window.location.pathname,
    navigator.userAgent,
    "",
    // Firefox and Safari leave the message out of the stack.
    error instanceof Error && !head.includes(error.message)
      ? `${error.name}: ${error.message}`
      : "",
    head,
    componentStack ? `\nComponent stack:${componentStack}` : "",
  ]
    .filter((line, i) => line || i === 4)
    .join("\n")
}

function CrashScreen({ crash, menu }: { crash: Crash; menu?: boolean }) {
  const openDrawer = useOpenDrawer()
  const [copied, setCopied] = useState<boolean | "failed">(false)
  const details = describe(crash)
  const message = crash.error instanceof Error ? crash.error.message : String(crash.error)

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-background text-foreground">
      {menu && (
        <header className="px-4 pt-[max(0.75rem,env(safe-area-inset-top))] md:hidden">
          <Button
            variant="outline"
            size="icon-lg"
            className="size-11 rounded-full"
            onClick={openDrawer}
            aria-label="Open conversations"
          >
            <MenuIcon />
          </Button>
        </header>
      )}
      <div
        role="alert"
        className="mx-auto flex w-full max-w-md flex-1 flex-col items-center justify-center gap-6 px-4 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))] text-center"
      >
        <Bot className="size-24 opacity-80 grayscale" />
        <div className="flex flex-col gap-2">
          <h1 className="text-xl font-semibold tracking-tight">Something went wrong</h1>
          {message && (
            <p className="line-clamp-3 font-mono text-xs break-words text-muted-foreground">
              {message}
            </p>
          )}
        </div>
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
          <Button size="lg" className="h-11" onClick={() => window.location.reload()}>
            <RotateCwIcon />
            Reload
          </Button>
          <Button
            size="lg"
            variant="outline"
            className="h-11"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(details)
                setCopied(true)
                window.setTimeout(() => setCopied(false), 1500)
              } catch {
                setCopied("failed")
              }
            }}
          >
            {copied === true ? <CheckIcon /> : <CopyIcon />}
            Copy details
          </Button>
        </div>
        {copied === "failed" && (
          <pre className="max-h-64 w-full overflow-auto rounded-2xl bg-muted p-3 text-left font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-all">
            {details}
          </pre>
        )}
      </div>
    </div>
  )
}

/**
 * Shows a crash screen in place of a render error, rather than a blank page. A new `resetKey`
 * (the screen's path) tries its children again.
 */
export class CrashBoundary extends Component<
  { children: ReactNode; resetKey?: string; menu?: boolean },
  { crash: Crash | null; key?: string }
> {
  state: { crash: Crash | null; key?: string } = { crash: null, key: this.props.resetKey }

  static getDerivedStateFromError(error: unknown) {
    return { crash: { error } }
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { crash: Crash | null; key?: string },
  ) {
    return props.resetKey === state.key ? null : { crash: null, key: props.resetKey }
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    // A chat that crashes shouldn't be reopened on the next launch.
    forgetLastChat()
    this.setState((state) =>
      state.crash?.error === error
        ? { crash: { error, componentStack: info.componentStack } }
        : null,
    )
  }

  render() {
    return this.state.crash ? (
      <CrashScreen crash={this.state.crash} menu={this.props.menu} />
    ) : (
      this.props.children
    )
  }
}
