/**
 * Why an app cannot be built on a bot, decided before any run starts. The screen puts this reason
 * on the build's control rather than starting a run a host cannot answer (ADR 0101): a host whose
 * plugin predates the app's section advertises no `apps` feature, and that reads as "this bot
 * cannot make apps" rather than as a fault; a build also needs the Interfaces switch on, since the
 * rules the model would build by are the switch's own fact (`openui-switch.ts`). `unknown` is
 * deliberately no refusal on either count — a Host that was away is asked again rather than read as
 * a `no`, and a switch not read yet is not an off (features.ts).
 */
import type { PluginFeatureAnswer } from "@/lib/features"

/** Why a build cannot start on this bot, if it can't. */
export function buildBlocked(
  apps: PluginFeatureAnswer,
  interfaces: boolean | undefined,
): string | undefined {
  if (apps === "no") return "This bot can't make apps"
  if (interfaces === false) return "Interfaces are turned off"
  return undefined
}
