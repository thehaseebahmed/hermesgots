import { useLiveQuery } from "dexie-react-hooks"
import type { ReactNode } from "react"

import { Cheatsheet, useCheatsheet } from "@/components/chat/cheatsheet"
import { Composer } from "@/components/chat/composer"
import type { ModeSettings } from "@/components/chat/mode-menu"
import { ModelMenu } from "@/components/chat/model-picker"
import { serverConfig } from "@/lib/connection"
import {
  DEFAULT_SETTINGS,
  getSettings,
  type Attachment,
  type ModelChoice,
  type Profile,
} from "@/lib/db"
import { usePluginFeature } from "@/lib/features"
import { chosenOf } from "@/lib/model-pick"
import { useNav } from "@/lib/nav"

/**
 * The chat's composer, from what a send needs rather than a chat's row: the bot, the model it runs
 * on, its draft key and the handlers. A chat-next surface with no record yet mounts this same
 * composer, so a chat that has nothing written for it is still drawn by the one composer.
 */
export function ChatComposer({
  bot,
  draftKey,
  modelChoice,
  onChooseModel,
  dictationHint,
  session,
  notice,
  main = false,
  botChat = true,
  home,
  busy,
  canSteer,
  subagents,
  runId,
  onSend,
  onQueue,
  onSteer,
  onStop,
  onThread,
}: {
  bot: Profile
  /** Where the unsent text is kept (`draftKey` in `lib/drafts.ts`), so it's there on return. */
  draftKey?: string
  /** The model the chat runs on: what its pill names, and what a send runs with. */
  modelChoice?: ModelChoice
  /** Where a pick from the pill goes. */
  onChooseModel: (choice: ModelChoice | undefined) => void
  /** Names the chat may mention (its title, a project's repos), to help the host hear them. */
  dictationHint?: string
  /** A project session: its permission mode, picked in the `+` menu. */
  session?: ModeSettings
  /** The account's warning, which the composer draws above its text while it holds. */
  notice?: ReactNode
  /** A bot's Main: `/thread` starts a thread of it. */
  main?: boolean
  /** A bot's chat: Main or one of its threads. `false` elsewhere. */
  botChat?: boolean
  /** Where `/new` goes: a thread's Main, else home. */
  home?: string
  busy: boolean
  canSteer: boolean
  /** How many of the session's subagents are still at work, which keep Stop rather than Send. */
  subagents: number
  /** The run Stop is for, so its acknowledgement ends when another run takes the button. */
  runId?: string
  onSend: (text: string, attachments: Attachment[]) => Promise<void> | void
  onQueue: (text: string, attachments: Attachment[]) => Promise<void> | void
  onSteer: (text: string, attachments: Attachment[]) => Promise<void> | void
  onStop: () => boolean | void | Promise<boolean>
  /** `/thread` in Main: a thread of the bot, opened on the message sent with it. */
  onThread?: (message: { text: string; attachments: Attachment[] }) => Promise<void> | void
}) {
  const { root } = useNav()
  const filesFeature = usePluginFeature(bot, "attachments")
  const sheet = useCheatsheet()
  const steerByDefault = useLiveQuery(async () => (await getSettings()).steerByDefault, [])
  const sendOnEnter = useLiveQuery(async () => (await getSettings()).sendOnEnter, [])
  // Without a key nothing on the host answers for Auto, so a session runs as Accept edits.
  const tracked = Boolean(bot.apiKey && !bot.disabled)
  return (
    <>
      <Composer
        busy={busy}
        notice={notice}
        connection={serverConfig(bot)}
        botName={bot.name}
        dictationWords={bot.vocabulary}
        dictationHint={dictationHint}
        draftKey={draftKey}
        filesFeature={filesFeature}
        imagesAvailable={bot.imageInput !== false}
        onSend={onSend}
        onQueue={onQueue}
        onSteer={onSteer}
        canSteer={canSteer}
        model={
          tracked && (
            <ModelMenu
              profile={bot}
              choice={chosenOf(modelChoice)}
              onChoose={onChooseModel}
              disabled={busy}
            />
          )
        }
        steerByDefault={Boolean(steerByDefault)}
        sendOnEnter={sendOnEnter ?? DEFAULT_SETTINGS.sendOnEnter}
        subagentsRunning={subagents}
        onStop={onStop}
        runId={runId}
        session={session}
        main={main}
        botChat={botChat}
        onCommand={async (command, message) => {
          if (command === "thread")
            return onThread?.({
              text: message?.text ?? "",
              attachments: message?.attachments ?? [],
            })
          if (command === "new") return root(home ?? "/")
          if (command === "settings") return root("/settings")
          if (command === "cheatsheet") return void sheet.show()
        }}
      />
      <Cheatsheet open={sheet.open} onOpenChange={sheet.setOpen} switches={sheet.switches} />
    </>
  )
}
