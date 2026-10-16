import { MODES, type ModelRow, type Period, type Row } from "./board"

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })
export const formatTokens = (value: number) => compact.format(value)

const escape = (value: string) =>
  value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const percent = (part: number, whole: number) => (whole ? (part / whole) * 100 : 0)

export interface RenderOptions {
  /** A real board shows the person's GitHub picture; the sample shows a bot. */
  live: boolean
  limit?: number
}

const BOTS = ["tri", "cubby", "penny", "hex", "stella", "orbi", "gem", "bloom"]

function picture(login: string, index: number, live: boolean) {
  const src = live
    ? `https://github.com/${encodeURIComponent(login)}.png?size=88`
    : `/bots/${BOTS[index % BOTS.length]}.png`
  return `<img class="avatar${live ? " round" : ""}" src="${src}" alt="" width="44" height="44" loading="lazy" referrerpolicy="no-referrer" />`
}

/** The period's top models and Others, each with the colour slot it keeps in the bars and legend. */
function slices(period: Period) {
  return [
    ...period.topModels.map((model, index) => ({ key: model, label: model, slot: `model-${index + 1}` })),
    { key: "", label: "Others", slot: "model-others" },
  ]
}

const amount = (row: Row, key: string) => (key ? (row.models[key] ?? 0) : row.others)

export function tokensLegend(period: Period) {
  return slices(period)
    .map((s) => `<li><span class="dot ${s.slot}"></span>${escape(s.label)}</li>`)
    .join("")
}

function tokenRow(row: Row, index: number, period: Period, options: RenderOptions) {
  // A model the person never used gets no sliver in their bar.
  const parts = slices(period)
    .filter((s) => amount(row, s.key) > 0)
    .map((s) => ({ ...s, percent: percent(amount(row, s.key), row.total) }))
  const label = parts
    .filter((p) => p.percent >= 1)
    .map((p) => `${Math.round(p.percent)}% ${escape(p.label)}`)
    .join(", ")
  const name = escape(row.login)
  const handle = options.live
    ? `<a href="https://github.com/${encodeURIComponent(row.login)}" rel="noreferrer">${name}</a>`
    : name
  return `<li class="row${index === 0 ? " first" : ""}">
  <span class="rank">${index + 1}</span>
  ${picture(row.login, index, options.live)}
  <div class="who">
    <span class="handle"><b>${handle}</b></span>
    <div class="split" role="img" aria-label="${label}">${parts.map((p) => `<span class="seg ${p.slot}" style="width:${p.percent}%"></span>`).join("")}</div>
  </div>
  <div class="tokens">${formatTokens(row.total)}<small>tokens</small></div>
</li>`
}

function modelRow(row: ModelRow, index: number) {
  const parts = MODES.map((mode) => ({ ...mode, percent: percent(row.modes[mode.key] ?? 0, row.tokens) }))
  const label = parts
    .filter((p) => p.percent >= 1)
    .map((p) => `${Math.round(p.percent)}% ${p.label.toLowerCase()}`)
    .join(", ")
  return `<li class="row model${index === 0 ? " first" : ""}">
  <span class="rank">${index + 1}</span>
  <div class="who wide">
    <span class="handle"><b>${escape(row.model)}</b><small>${row.users} ${row.users === 1 ? "person" : "people"}</small></span>
    <div class="split" role="img" aria-label="${label}">${parts.map((p) => `<span class="seg mode-${p.key}" style="width:${p.percent}%"></span>`).join("")}</div>
  </div>
  <div class="tokens">${formatTokens(row.tokens)}<small>tokens</small></div>
</li>`
}

const empty = '<li class="empty">No one has shared yet.</li>'

export function tokensList(period: Period, options: RenderOptions) {
  const rows = period.tokens.slice(0, options.limit ?? 10)
  return rows.length ? rows.map((row, i) => tokenRow(row, i, period, options)).join("") : empty
}

export function modelsList(period: Period, options: RenderOptions) {
  const rows = period.models.slice(0, options.limit ?? 10)
  return rows.length ? rows.map((row, i) => modelRow(row, i)).join("") : empty
}
