import { useEffect, useState } from 'react'
import { ArrowUp, GitPullRequest, Plus, SquarePen } from 'lucide-react'
import { Badge, Bar, Button, Check, Collapse, Field, LockScreen, Notification, Phone, Roll, Stage, Stream, Text, Window, WALLPAPER, type Act } from '../../stageshow/kit'
// The site serves the bots and the app's icon from public/
const appIcon = '/app-icon.png'
const byte = '/bots/byte/happy.webp'
const byteWave = '/bots/byte/wave.webp'
const crumb = '/bots/crumb/happy.webp'
const nova = '/bots/nova/happy.webp'
const pip = '/bots/pip/happy.webp'
import './gots.css'

// Gots's hero: ask, walk away, come back to it done. A device pair: the
// laptop's chat with Byte pinned top-left and off the bottom, the phone
// straddling its right edge over the thread's quiet margin.
//
// Beats: a new chat with Byte waits; the cursor types the ask and sends it;
// Byte thinks, then runs its commands while the cursor leaves (the app is put
// away); the reply streams and a draft pull request lands under it; the phone
// lights with the push that says so. The payoff holds, then the cursor comes
// back and opens a new chat: the visible cause that clears the thread and the
// notification together, back on the opening frame.
//
// Real strings: Byte, its greeting, the ask, the work line, the reply, the
// pull request and its checks, the notification. Everything else is filler.

const ASK = 'Fix the flaky test and open a PR.'
const REPLY = 'The test waited on a real timer. It now uses fake timers and passes 50 runs in a row.'
const WORDS = REPLY.split(' ').length

type Phase = 'idle' | 'thinking' | 'working' | 'done'

type S = {
  draft: string
  focus: boolean
  sent: boolean
  phase: Phase
  words: number
  pr: boolean
  pushed: boolean
}

const REST = { wide: { x: 560, y: 300 }, compact: { x: 220, y: 150 } }

const initial: S = { draft: '', focus: false, sent: false, phase: 'idle', words: 0, pr: false, pushed: false }
const poster: S = { draft: '', focus: false, sent: true, phase: 'done', words: WORDS, pr: true, pushed: true }

async function script(a: Act<S>) {
  await a.wait(600)
  a.mark('type')
  await a.move('composer')
  await a.click('composer')
  a.put({ focus: true })
  await a.type('draft', ASK, { interval: 38 })
  await a.wait(250)
  await a.move('send')
  await a.click('send')
  a.mark('send')
  a.put({ sent: true, draft: '', focus: false })
  await a.wait(500)
  a.put({ phase: 'thinking' })
  await a.wait(1200)
  a.mark('work')
  a.put({ phase: 'working' })
  // The app is put away: the cursor leaves while the host keeps working
  void a.move(a.layout === 'compact' ? { x: 420, y: 660 } : { x: 1120, y: 520 }, { duration: 900 })
  await a.wait(1700)
  a.put({ phase: 'done' })
  await a.wait(350)
  a.mark('reply')
  for (let i = 1; i <= WORDS; i++) {
    a.put({ words: i })
    await a.wait(38)
  }
  await a.wait(350)
  a.put({ pr: true })
  await a.wait(700)
  a.mark('push')
  a.put({ pushed: true })
  await a.wait(2600)
  // Back at the laptop: a new chat clears this one, and opening it settles the push
  a.mark('reset')
  // Aimed at the button's end, off its label
  const button = a.layout === 'compact' ? 'new' : { at: 'new', x: 0.88, y: 0.5 }
  await a.enter(button)
  await a.click(button)
  a.put(initial)
  // Back to the rest point, so the next loop starts where this one did
  await a.wait(500)
  await a.move(a.layout === 'compact' ? REST.compact : REST.wide, { duration: 600 })
}

function BotRow({ src, selected, w }: { src: string; selected?: boolean; w: number }) {
  return (
    <div className="gh-bot" data-selected={selected || undefined}>
      <img src={src} alt="" width={28} height={28} />
      {selected ? <Text className="gh-bot__name">Byte</Text> : <Bar w={w} h={6} tone={2} />}
    </div>
  )
}

// The scene follows the page's colour scheme, as the rest of the site does
function usePageTheme() {
  const [dark, setDark] = useState(false)
  useEffect(() => {
    const query = matchMedia('(prefers-color-scheme: dark)')
    const update = () => setDark(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return dark ? 'dark' : 'light'
}

export default function GotsHero() {
  const theme = usePageTheme()
  return (
    <Stage
      theme={theme}
      width={1040}
      height={430}
      compact={{ below: 640, width: 358, height: 600 }}
      initial={initial}
      poster={poster}
      script={script}
      play="loop"
      cursor={{ at: REST }}
      className="gh"
    >
      {(s, _rect, layout) => {
        const narrow = layout === 'compact'
        return (
        <>
          <Window
            className="gh-win"
            sidebarWidth={200}
            lead={<span className="gh-title"><Roll>{s.sent ? 'Fix the flaky test' : 'New chat'}</Roll></span>}
            toolbar={
              narrow ? (
                <Button variant="ghost" className="gh-new-icon" icon={<SquarePen size={15} strokeWidth={2} />} aria-label="New chat" data-target="new" data-cursor="pointer" />
              ) : undefined
            }
            sidebar={
              narrow ? undefined : (
              <div className="gh-side">
                <Button className="gh-new" icon={<SquarePen size={14} strokeWidth={2} />} data-target="new" data-cursor="pointer">
                  New chat
                </Button>
                <div className="gh-bots">
                  <BotRow src={byte} selected w={0} />
                  <BotRow src={nova} w={52} />
                  <BotRow src={pip} w={40} />
                  <BotRow src={crumb} w={58} />
                </div>
              </div>
              )
            }
          >
            <div className="gh-pane">
              <div className="gh-thread">
                {/* A new chat says who it is with: the bot's face and one of its lines */}
                <Collapse open={!s.sent}>
                  <div className="gh-empty">
                    <img src={byteWave} alt="" width={72} height={72} />
                    <Text className="gh-greeting">Give me the spec and I'll handle the rest.</Text>
                  </div>
                </Collapse>
                <Collapse open={s.sent} reveal="drop" from="below">
                  <div className="gh-ask">
                    <Text>{ASK}</Text>
                  </div>
                </Collapse>
                <Collapse open={s.phase !== 'idle'}>
                  <div className="gh-work">
                    <div className="gh-line" data-live={s.phase === 'thinking' || undefined}>
                      <Roll>{s.phase === 'thinking' ? 'Thinking' : 'Thought for 6s'}</Roll>
                    </div>
                    <Collapse open={s.phase === 'working' || s.phase === 'done'}>
                      <div className="gh-line gh-tool">
                        <span className="gh-mark">
                          <Check on={s.phase === 'done'} pending size={14} />
                        </span>
                        <Roll>{s.phase === 'done' ? 'Ran 3 commands, edited retry.test.ts' : 'Running tests'}</Roll>
                      </div>
                    </Collapse>
                  </div>
                </Collapse>
                <Collapse open={s.words > 0}>
                  <div className="gh-reply">
                    <Stream className="gh-stream" text={REPLY} count={s.words} />
                    <div className="gh-pr" data-on={s.pr || undefined}>
                      <span className="gh-pill">
                        <GitPullRequest size={14} strokeWidth={2} />
                        Draft #214
                      </span>
                      <Badge tone="success">Checks passing</Badge>
                    </div>
                  </div>
                </Collapse>
              </div>
              <Field
                className="gh-composer"
                value={s.draft}
                placeholder="Message Byte"
                focused={s.focus}
                box={{ 'data-target': 'composer' }}
                leading={
                  <span className="gh-plus">
                    <Plus size={16} strokeWidth={2} />
                  </span>
                }
                trailing={
                  <span className="gh-send" data-target="send" data-cursor="pointer" data-ready={s.draft !== '' || undefined}>
                    <ArrowUp size={16} strokeWidth={2.25} />
                  </span>
                }
              />
            </div>
          </Window>

          <Phone width={narrow ? 326 : 272} frame="pro" dark wallpaper={WALLPAPER} className="gh-phone">
            <LockScreen size="satellite" stack="top" date="Saturday, November 15" time="9:41">
              <div className="gh-push" data-on={s.pushed || undefined}>
                <Notification
                  icon={<img src={appIcon} alt="" className="gh-app" />}
                  title="Fix the flaky test"
                  body="Your draft pull request is ready."
                />
              </div>
            </LockScreen>
          </Phone>
        </>
        )
      }}
    </Stage>
  )
}

