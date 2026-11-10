import { PICK_BUDGET } from "@/lib/afk-picks"
import { connectionKey } from "@/lib/connection"
import { READ_TIMEOUT_MS } from "@/lib/freshness"
import { refreshAnswer } from "@/lib/features"
import { keepHost } from "@/lib/host-cache"
import { noteFailure } from "@/lib/report"

type Server = { baseUrl: string; apiKey: string }

const warming = new Set<string>()

/**
 * Reads every Settings > Bot page once as a bot is linked and keeps the answers (ADR 0132), so the
 * first open already has values. Best effort: each read is bounded and a failure leaves that page to
 * its own first open. Imported lazily by its callers — it reaches every page's module.
 */
export async function warmBotSettings(server: Server) {
  const key = connectionKey(server)
  if (warming.has(key)) return
  warming.add(key)
  try {
    const [hermes, host, delegation, fallbacks, reminders, triage] = await Promise.all([
      import("@/lib/hermes"),
      import("@/lib/host-record"),
      import("@/lib/delegation"),
      import("@/lib/fallbacks"),
      import("@/lib/reminders"),
      import("@/lib/triage-model"),
    ])
    refreshAnswer(server)
    const signal = () => AbortSignal.timeout(READ_TIMEOUT_MS)
    const attempt = (what: string, run: () => Promise<unknown>) =>
      run().catch((error: unknown) => noteFailure(`Warming the bot's ${what}`, error))
    await Promise.all([
      attempt("General settings", async () =>
        keepHost(
          server,
          hermes.GENERAL_ROUTES.general.path,
          await hermes.getGeneralSettings(server, "general", signal()),
        ),
      ),
      attempt("Delegation settings", async () =>
        keepHost(
          server,
          hermes.GENERAL_ROUTES.delegation.path,
          await hermes.getGeneralSettings(server, "delegation", signal()),
        ),
      ),
      attempt("Coding settings", async () => {
        const answer = await hermes.getBotAfk(server, signal())
        await keepHost(server, "bot-afk", {
          budget: answer.pickBudget ?? PICK_BUDGET.unset,
          threshold: answer.usageThreshold,
        })
      }),
      attempt("MCP servers", async () =>
        keepHost(server, "mcp", await hermes.listMcpServers(server, signal())),
      ),
      attempt("delegation model", () => host.warmHostRecord(server, delegation.DELEGATION)),
      attempt("fallbacks", () => host.warmHostRecord(server, fallbacks.FALLBACKS)),
      attempt("reminders", () => host.warmHostRecord(server, reminders.REMINDERS)),
      attempt("triage model", () => host.warmHostRecord(server, triage.TRIAGE)),
    ])
  } finally {
    warming.delete(key)
  }
}
