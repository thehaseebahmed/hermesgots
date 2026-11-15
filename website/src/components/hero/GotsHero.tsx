import { useEffect, useState } from 'react'
import {
  ArrowLeft,
  ArrowUp,
  Check as Tick,
  CircleAlert,
  Code,
  FolderOpen,
  Frame,
  History,
  Menu,
  MessageCircle,
  MessageCircleQuestion,
  Mic,
  MoreVertical,
  Plus,
  Search,
  SendHorizontal,
  Smile,
  Telescope,
  Video,
  X,
} from 'lucide-react'
import { Bar, Collapse, Keyboard, Phone, Stage, States, Stream, Text, Window, type Act } from '../../stageshow/kit'
import './gots.css'

// Gots's hero: start on the phone, finish at the laptop. Leaving the office,
// the user dictates a text with the Bubble, asks Nova to plan the trip and
// pockets the phone. Nova's one question arrives on the lock screen and is
// answered from the notification. At home the laptop's list already holds the
// chat, and opening it shows the phone's message, the answered question and
// the plan Nova drew.
//
// Two things here are ahead of the app, on purpose and recorded in
// REHEARSAL.md: answering a question from the notification, and photos in a
// drawn interface. The photos are drawn stand-ins until licensed ones land.

const TEXT = "Leaving now. Let's plan Lisbon when I'm home."
const ASK = 'Plan a long weekend in Lisbon for us.'
const TITLE = 'Lisbon long weekend'
const QUESTION = 'When would you like to go?'
const PICK = 'Apr 15–19'
const INTRO = 'Pale limestone, yellow trams and river light, from Thursday to Sunday.'
const INTRO_WORDS = INTRO.split(' ').length

const nova = '/bots/nova/happy.webp'
const novaWave = '/bots/nova/wave.webp'
const pip = '/bots/pip/happy.webp'
const crumb = '/bots/crumb/happy.webp'
const byte = '/bots/byte/happy.webp'
const appIcon = '/app-icon.png'

type App = 'messages' | 'gots' | 'lock'
type Phase = 'idle' | 'thinking' | 'asked' | 'writing' | 'done'

type S = {
  app: App
  time: string
  bubble: 'idle' | 'rec' | 'wait'
  text: string
  texted: boolean
  keys: boolean
  focus: boolean
  draft: string
  asked: boolean
  phase: Phase
  push: 'none' | 'shown' | 'answered'
  home: boolean
  unread: boolean
  open: boolean
  words: number
  parts: number
  away: boolean
  tap: { x: number; y: number; n: number }
  swipe: number
}

const REST = { wide: { x: 300, y: 470 }, compact: { x: 300, y: 600 } }

const initial: S = {
  app: 'messages',
  time: '6:24',
  bubble: 'idle',
  text: '',
  texted: false,
  keys: true,
  focus: true,
  draft: '',
  asked: false,
  phase: 'idle',
  push: 'none',
  home: false,
  unread: false,
  open: false,
  words: 0,
  parts: 0,
  away: false,
  tap: { x: -99, y: -99, n: 0 },
  swipe: 0,
}

const poster: S = {
  ...initial,
  app: 'lock',
  texted: true,
  keys: false,
  focus: false,
  asked: true,
  phase: 'done',
  home: true,
  open: true,
  words: INTRO_WORDS,
  parts: 3,
}

// The app's loader: a ring with an arc turning inside a still frame, so its
// box never changes size as it turns
function Loader({ size = 16 }: { size?: number }) {
  return (
    <svg className="gh-loader" viewBox="0 0 16 16" width={size} height={size} aria-hidden>
      <circle cx="8" cy="8" r="6.25" fill="none" strokeWidth="1.6" className="gh-loader__track" />
      <g>
        <path d="M8 1.75a6.25 6.25 0 0 1 6.25 6.25" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </g>
    </svg>
  )
}

// A finger on the phone: a soft dot where it lands. The stage's cursor is the
// laptop's, so the phone's touches are drawn on their own.
async function tap(a: Act<S>, name: string) {
  const r = a.rect(name)
  a.put((s) => ({ tap: { x: r.x + r.width / 2, y: r.y + r.height / 2, n: s.tap.n + 1 } }))
  await a.wait(240)
}

async function script(a: Act<S>) {
  await a.wait(700)
  // The Bubble: tap to talk, tap the tick, the words land in the field
  a.mark('dictate')
  await tap(a, 'bubble')
  a.put({ bubble: 'rec' })
  await a.wait(2000)
  await tap(a, 'bubble-done')
  a.put({ bubble: 'wait' })
  await a.wait(650)
  a.put({ bubble: 'idle', text: TEXT })
  await a.wait(700)
  await tap(a, 'text-send')
  a.mark('texted')
  a.put({ texted: true, text: '' })
  await a.wait(900)
  // A swipe along the gesture bar switches to Gots
  a.put((s) => ({ swipe: s.swipe + 1 }))
  await a.wait(320)
  a.put({ app: 'gots' })
  await a.wait(900)
  a.mark('ask')
  await tap(a, 'composer')
  await a.wait(250)
  await a.type('draft', ASK, { interval: 42 })
  await a.wait(250)
  await tap(a, 'send')
  a.put({ asked: true, draft: '', keys: false, focus: false, phase: 'thinking' })
  await a.wait(1700)
  // Pocketed: the screen locks while Nova works, and its question arrives there
  a.mark('lock')
  a.put({ app: 'lock' })
  await a.wait(1100)
  a.put({ phase: 'asked', push: 'shown' })
  await a.wait(1700)
  await tap(a, 'push-pick')
  a.mark('answer')
  a.put({ push: 'answered', phase: 'writing' })
  await a.wait(900)
  a.put({ push: 'none' })
  await a.wait(700)
  // Home: the phone goes down and the laptop is the one in front
  a.mark('home')
  a.put({ home: true })
  await a.wait(700)
  a.put({ phase: 'done', unread: true })
  await a.wait(500)
  await a.move('row')
  await a.click('row')
  a.mark('open')
  a.put({ open: true, unread: false })
  await a.wait(450)
  for (let i = 1; i <= INTRO_WORDS; i++) {
    a.put({ words: i })
    await a.wait(34)
  }
  for (let i = 1; i <= 3; i++) {
    await a.wait(320)
    a.put({ parts: i })
  }
  void a.move(a.layout === 'compact' ? REST.compact : REST.wide, { duration: 900 })
  await a.wait(3200)
  // A new evening: the phone is picked up again and the laptop put away;
  // what the loop added is cleared out of view, then the laptop comes back
  // and the phone unlocks into the messages app
  a.mark('reset')
  await a.snap({ texted: false, text: '', bubble: 'idle', draft: '' })
  a.put({ home: false, away: true, app: 'messages', keys: true, focus: true })
  await a.wait(750)
  await a.snap({ ...initial, away: true })
  a.put({ away: false })
  await a.wait(1000)
}

// The Bubble, as BubbleView.kt draws it: a dark mark of five bars at rest, a
// pill of cancel, level and done while it records, and a spinner while the
// host hears the take
function Bubble({ face }: { face: S['bubble'] }) {
  return (
    <div className="gh-bubble" data-face={face} data-target="bubble">
      <span className="gh-bubble__mark" aria-hidden>
        {[8, 14, 20, 14, 8].map((h, i) => (
          <i key={i} style={{ height: h }} />
        ))}
      </span>
      <span className="gh-bubble__pill" aria-hidden>
        <X size={20} strokeWidth={2.25} />
        <span className="gh-bubble__level">
          {Array.from({ length: 14 }, (_, i) => (
            <i key={i} style={{ animationDelay: `${(i * 97) % 600}ms` }} />
          ))}
        </span>
        <span className="gh-bubble__done" data-target="bubble-done">
          <Tick size={20} strokeWidth={2.5} />
        </span>
      </span>
      <span className="gh-bubble__wait" aria-hidden>
        <Loader size={22} />
      </span>
    </div>
  )
}

// A plain messages app: no one's brand, the shape every Android phone has
function Messages({ s }: { s: S }) {
  return (
    <div className="gh-sms">
      <div className="gh-sms__bar">
        <ArrowLeft size={24} />
        <span className="gh-sms__face">S</span>
        <span className="gh-sms__name">Sam</span>
        <Video size={24} />
        <MoreVertical size={24} />
      </div>
      <div className="gh-sms__thread">
        <div className="gh-sms__msg" data-from="them">
          <Bar w={150} h={9} tone={2} />
          <Bar w={96} h={9} tone={2} />
        </div>
        <Collapse open={s.texted} reveal="drop" from="below">
          <div className="gh-sms__msg" data-from="me">
            {TEXT}
          </div>
        </Collapse>
      </div>
      <div className="gh-sms__compose">
        <span className="gh-sms__round">
          <Plus size={22} />
        </span>
        <div className="gh-sms__field" data-filled={s.text !== '' || undefined}>
          <Smile size={22} />
          <span className="gh-sms__text">
            {s.text || <span className="gh-sms__hint">Text message</span>}
          </span>
        </div>
        <span className="gh-sms__send" data-target="text-send" data-ready={s.text !== '' || undefined}>
          <SendHorizontal size={20} />
        </span>
      </div>
      <Bubble face={s.bubble} />
    </div>
  )
}

// The composer as the app draws it: words on top, + and the voice and send
// controls under them
function Composer({ s, compact }: { s: S; compact?: boolean }) {
  return (
    <div className="gh-composer" data-target="composer" data-focus={s.focus || undefined} data-compact={compact || undefined}>
      <span className="gh-composer__text">
        {s.draft ? (
          <span data-typing data-snap>
            {s.draft}
            <span className="gh-caret" data-typing />
          </span>
        ) : (
          <span className="gh-composer__hint">Message Nova…</span>
        )}
      </span>
      <span className="gh-composer__row">
        <Plus size={20} strokeWidth={2} />
        <span className="gh-composer__end">
          <Mic size={18} strokeWidth={2} />
          <span className="gh-composer__send" data-target="send" data-ready={s.draft !== '' || undefined}>
            <ArrowUp size={18} strokeWidth={2.5} />
          </span>
        </span>
      </span>
    </div>
  )
}

function StatusLine({ text }: { text: string }) {
  return (
    <div className="gh-status">
      <Loader size={16} />
      <span>{text}</span>
    </div>
  )
}

// Gots on the phone: a new chat with Nova, then the ask and Nova at work
function GotsPhone({ s }: { s: S }) {
  return (
    <div className="gh-app">
      <div className="gh-app__bar">
        <span className="gh-round">
          <Menu size={20} />
        </span>
        <img src={nova} alt="" className="gh-app__face" />
        <span className="gh-app__title">
          <States align="start" value={s.asked ? 'asked' : 'new'} states={{ new: 'New chat', asked: TITLE }} />
        </span>
        <span className="gh-round">
          <ArrowLeft size={20} />
        </span>
      </div>
      <div className="gh-app__thread">
        <div className="gh-empty" data-on={!s.asked || undefined}>
          <img src={novaWave} alt="" width={96} height={96} />
          <Text className="gh-empty__line">Where are we heading today?</Text>
        </div>
        <Collapse open={s.asked} reveal="drop" from="below">
          <div className="gh-mine">
            {ASK}
          </div>
        </Collapse>
        <Collapse open={s.asked}>
          <StatusLine text="Thinking" />
        </Collapse>
      </div>
      <div className="gh-app__foot">
        <Composer s={s} />
      </div>
    </div>
  )
}

// The lock screen, Android's: the clock, then the notification. Its two
// buttons answer Nova's question where it is asked.
function Lock({ s }: { s: S }) {
  return (
    <div className="gh-lock">
      <div className="gh-lock__clock">{s.time.replace(':', '\n')}</div>
      <div className="gh-lock__date">Sat, Nov 15</div>
      <div className="gh-note" data-on={s.push !== 'none' || undefined} data-answered={s.push === 'answered' || undefined}>
        <div className="gh-note__head">
          <img src={appIcon} alt="" />
          <span>Gots</span>
          <span className="gh-note__when">· now</span>
        </div>
        <div className="gh-note__title">{TITLE}</div>
        <div className="gh-note__body">{QUESTION}</div>
        <div className="gh-note__actions">
          <span>Feb 18–22</span>
          <span data-target="push-pick">{PICK}</span>
        </div>
        <div className="gh-note__sent">
          <Tick size={16} strokeWidth={2.5} /> Answered
        </div>
      </div>
    </div>
  )
}

// A filler row: the same anatomy, bars in place of words
function Row({ w }: { w: number }) {
  return (
    <div className="gh-row" data-filler>
      <span className="gh-row__icon">
        <MessageCircle size={17} />
      </span>
      <span className="gh-row__text">
        <Bar w={w} h={8} tone={2} />
        <Bar w={w + 40} h={7} tone={1} />
      </span>
    </div>
  )
}

// The laptop's list of Nova's chats: the chat the phone started is already
// in it, saying what it is waiting on, then that a reply is unread
function ChatList({ s }: { s: S }) {
  const waiting = s.phase === 'asked'
  const working = s.phase === 'thinking' || s.phase === 'writing'
  return (
    <div className="gh-list">
      <div className="gh-list__head">
        <img src={nova} alt="" />
        <span>Nova</span>
        <span className="gh-round gh-round--line">
          <History size={16} />
        </span>
      </div>
      <div className="gh-search">
        <Search size={16} />
        <span>Search chats</span>
      </div>
      <div className="gh-pills">
        <span data-on>All</span>
        <span>Unread</span>
        <span>Chats</span>
        <span>Rooms</span>
      </div>
      <div className="gh-rows">
        <Collapse open={s.asked} reveal="drop">
          <div className="gh-row gh-row--live" data-target="row" data-cursor="pointer" data-selected={s.open || undefined}>
            <span className="gh-row__icon" data-tone={waiting ? 'warning' : undefined}>
              <span className="gh-row__glyph" data-on={waiting || undefined}>
                <CircleAlert size={17} />
              </span>
              <span className="gh-row__glyph" data-on={working || undefined}>
                <Loader size={17} />
              </span>
              <span className="gh-row__glyph" data-on={(!waiting && !working) || undefined}>
                <MessageCircle size={17} />
              </span>
              <span className="gh-row__dot" data-on={s.unread || undefined} />
            </span>
            <span className="gh-row__text">
              <span className="gh-row__top">
                <Text className="gh-row__title">{TITLE}</Text>
                <span className="gh-row__when">now</span>
              </span>
              <span className="gh-row__line" data-warn={waiting || undefined}>
                <States
                  align="start"
                  value={waiting ? 'waiting' : s.phase === 'done' ? 'done' : 'working'}
                  states={{ working: 'Working on it', waiting: 'Awaiting your answer', done: 'Here’s your long weekend.' }}
                />
              </span>
            </span>
          </div>
        </Collapse>
        <Row w={96} />
        <Row w={120} />
        <Row w={78} />
        <Row w={104} />
      </div>
      <span className="gh-fab">
        <Plus size={20} strokeWidth={2.25} />
      </span>
    </div>
  )
}

const PLACES = [
  { name: 'Alfama', where: 'Old Town', look: 'alfama' },
  { name: 'Senhora do Monte', where: 'Graça', look: 'monte' },
  { name: 'Jerónimos', where: 'Belém', look: 'belem' },
]

const TASTES = [
  ['Pastel de nata', '€1.50'],
  ['Bacalhau à Brás', '€16'],
  ['Polvo à lagareiro', '€22'],
]

// The chat opened on the laptop: the message sent from the phone, the
// question it answered there, and the interface Nova drew in the app's own
// cards
function Chat({ s }: { s: S }) {
  return (
    <div className="gh-chat">
      <div className="gh-chat__head">
        <span className="gh-chat__title">{TITLE}</span>
        <span className="gh-round gh-round--line">
          <ArrowLeft size={16} />
        </span>
      </div>
      <div className="gh-chat__thread">
        <div className="gh-mine">
          {ASK}
        </div>
        <div className="gh-answered">
          <div className="gh-answered__head">
            <MessageCircleQuestion size={15} />
            Answered
          </div>
          <div className="gh-answered__q">{QUESTION}</div>
          <div className="gh-answered__a">{PICK}</div>
        </div>
        <div className="gh-ui">
          <div className="gh-ui__title">A long weekend in Lisbon</div>
          <Stream className="gh-ui__intro" text={INTRO} count={s.words} />
          <div className="gh-ui__places">
            {PLACES.map((p, i) => (
              <div key={p.name} className="gh-place" data-on={s.parts > i || undefined}>
                <span className="gh-photo" data-look={p.look} />
                <span className="gh-place__name">{p.name}</span>
                <span className="gh-place__where">{p.where}</span>
              </div>
            ))}
          </div>
          <div className="gh-ui__table" data-on={s.parts > 2 || undefined}>
            <div className="gh-ui__caption">Three things to taste</div>
            {TASTES.map(([dish, price]) => (
              <div key={dish} className="gh-ui__tr">
                <span>{dish}</span>
                <span>{price}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Rail() {
  return (
    <div className="gh-rail">
      <span className="gh-rail__icon">
        <FolderOpen size={18} />
      </span>
      <span className="gh-rail__icon">
        <Code size={18} />
      </span>
      <span className="gh-rail__icon">
        <Frame size={18} />
      </span>
      <span className="gh-rail__icon">
        <Telescope size={18} />
      </span>
      <span className="gh-rail__rule" />
      <span className="gh-rail__bot" data-on>
        <img src={nova} alt="" />
      </span>
      <span className="gh-rail__bot">
        <img src={byte} alt="" />
      </span>
      <span className="gh-rail__bot">
        <img src={pip} alt="" />
      </span>
      <span className="gh-rail__bot">
        <img src={crumb} alt="" />
      </span>
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
      height={560}
      compact={{ below: 640, width: 358, height: 640 }}
      initial={initial}
      poster={poster}
      script={script}
      play="loop"
      cursor={{ at: REST, idle: 1500 }}
      className="gh"
    >
      {(s, _rect, layout) => {
        const narrow = layout === 'compact'
        return (
          <div className="gh-scene" data-away={s.away || undefined} data-home={s.home || undefined} data-open={s.open || undefined}>
            <Window className="gh-win" receded={!s.home} sidebarWidth={76} sidebar={narrow ? undefined : <Rail />}>
              <div className="gh-pane">
                <ChatList s={s} />
                <div className="gh-side">
                  <div className="gh-none">
                    <MessageCircle size={40} strokeWidth={1.75} />
                    <span>No chat selected</span>
                  </div>
                  <Chat s={s} />
                </div>
              </div>
            </Window>

            <div className="gh-hand">
              <Phone width={narrow ? 310 : 350} frame="android" time={s.time} dark={s.app === 'lock'} wallpaper={s.app === 'lock' ? 'linear-gradient(180deg, #1d2a3a 0%, #2c3b52 55%, #4a4a63 100%)' : undefined} className="gh-phone">
                <div className="gh-screens" data-app={s.app}>
                  <div className="gh-screen" data-name="messages">
                    <Messages s={s} />
                  </div>
                  <div className="gh-screen" data-name="gots">
                    <GotsPhone s={s} />
                  </div>
                  <div className="gh-screen" data-name="lock">
                    <Lock s={s} />
                  </div>
                  <div className="gh-keys" data-on={s.keys || undefined}>
                    <Keyboard typed={s.app === 'gots' ? s.draft : ''} suggestions={['the', 'I', 'and']} />
                  </div>
                  <span key={s.swipe} className="gh-swipe" data-go={s.swipe > 0 || undefined} />
                </div>
              </Phone>
            </div>

            <span key={s.tap.n} className="gh-tap" style={{ left: s.tap.x, top: s.tap.y }} data-go={s.tap.n > 0 || undefined} />
          </div>
        )
      }}
    </Stage>
  )
}
