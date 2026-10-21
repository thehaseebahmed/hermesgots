import { toast } from "sonner"

/** Runs an action, saying why when it fails. */
export async function attempt(what: string, action: () => Promise<unknown>) {
  try {
    await action()
    return true
  } catch (error) {
    toast.error(error instanceof Error ? error.message : `Couldn't ${what}.`)
    return false
  }
}
