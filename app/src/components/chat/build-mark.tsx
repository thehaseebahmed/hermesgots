import { Divider } from "@/components/chat/divider"

/**
 * A build's visit, marked in its run: the phase it entered, what its check found and how long it
 * took, drawn through the thread's one divider so a mark on a run reads the way a compaction or a
 * model change does (ADR 0087). A label, never a control: the lane's row is what a reader presses.
 */
export function BuildMark({ words, flag }: { words: string; flag?: string }) {
  return (
    <div data-build-mark={words} {...(flag ? { "data-build-flag": flag } : {})}>
      <Divider text={words} spoken={`Build: ${words}`} slot="build-mark" />
    </div>
  )
}
