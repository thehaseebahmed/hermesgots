import { Component, createRef, type ReactNode } from "react"

import { prefersReducedMotion } from "@/lib/media"

// A plain fade rather than Material's fade through: two items of one list share their chrome (a
// session's header, composer and banners), and a fade through took all of it to nothing and back
// on every switch — the flashing Material says to answer with a fade.
export const FADE_MS = 250
const OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }]

interface Ghost {
  node: HTMLElement
  scrolls: [Element, number, number][]
}


/** A still copy of what a pane shows, scrolled where it was, that nothing can reach or act on. */
function copy(live: HTMLElement): Ghost {
  const node = live.cloneNode(true) as HTMLElement
  const from = live.querySelectorAll("*")
  const to = node.querySelectorAll("*")
  const scrolls: Ghost["scrolls"] = []
  for (let at = 0; at < from.length; at += 1) {
    const { scrollTop, scrollLeft } = from[at]
    if (scrollTop || scrollLeft) scrolls.push([to[at], scrollTop, scrollLeft])
    // A thread's rows draw only near the screen, standing at a guessed height until then; the copy
    // starts every row on that guess, so each is given the height it really had, or the copy's
    // offset lands on other words than the ones it was showing.
    if (from[at].matches('[data-slot="message-scroller-item"]'))
      (to[at] as HTMLElement).style.containIntrinsicSize =
        `auto ${from[at].getBoundingClientRect().height}px`
  }
  for (const one of [node, ...to]) {
    one.removeAttribute("id")
    one.removeAttribute("data-pane")
    if (one.getAttribute("data-slot") === "chat-pane") one.removeAttribute("data-slot")
  }
  node.setAttribute("inert", "")
  node.setAttribute("aria-hidden", "true")
  node.className = `${node.className} pointer-events-none absolute inset-0`
  return { node, scrolls }
}

/**
 * The item pane beside a list. When the item it shows changes, the item left is copied just before
 * React replaces it and fades out above the one asked for, which is drawn beneath it as soon as it
 * can be (a chat landing there plays its own fade in, so the two cross). The copy is taken in
 * `getSnapshotBeforeUpdate`, the one moment the old DOM is still whole, which is why this is a class.
 */
export class PaneTransition extends Component<{ item?: string; children: ReactNode }> {
  private live = createRef<HTMLDivElement>()
  private layer = createRef<HTMLDivElement>()
  private timer: number | undefined

  getSnapshotBeforeUpdate(previous: { item?: string }): Ghost | null {
    const live = this.live.current
    const { item } = this.props
    if (!live || !previous.item || !item || previous.item === item || prefersReducedMotion()) return null
    return copy(live)
  }

  componentDidUpdate(_: unknown, __: unknown, ghost: Ghost | null) {
    const layer = this.layer.current
    if (!ghost || !layer) return
    this.settle()
    layer.append(ghost.node)
    for (const [element, top, left] of ghost.scrolls) {
      element.scrollTop = top
      element.scrollLeft = left
    }
    ghost.node.animate(OUT, {
      duration: FADE_MS,
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      fill: "forwards",
    })
    // A timer rather than the animation's own promise, so the copy goes wherever animation can't run.
    this.timer = window.setTimeout(() => ghost.node.remove(), FADE_MS)
  }

  componentWillUnmount() {
    this.settle()
  }

  /** Drops a copy still fading, so a quick second switch fades from what is on screen. */
  private settle() {
    window.clearTimeout(this.timer)
    this.layer.current?.replaceChildren()
  }

  render() {
    return (
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <div ref={this.live} className="flex min-h-0 min-w-0 flex-1 flex-col">
          {this.props.children}
        </div>
        <div ref={this.layer} className="contents" />
      </div>
    )
  }
}
