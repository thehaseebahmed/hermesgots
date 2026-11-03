/**
 * The Network log's two surfaces: the Developer switch that starts recording, and the screen that
 * reads what it recorded — the pills, the numbers, the table and a failure's own words (ADR 0086).
 */
import assert from "node:assert/strict"
import test from "node:test"
import { MemoryRouter } from "react-router"

import { NetworkLogScreen } from "@/components/network-log"
import { db, type NetRequest } from "@/lib/db"
import { KEPT } from "@/lib/net-log"
import { clearNetLog, trimNetLog } from "@/lib/net-recorder"
import { DeveloperSettings } from "@/routes/settings"
import { botProfile, click, find, findAll, mount, seedSettings, text } from "./component-kit.tsx"

const ada = botProfile("network-ada", { id: "bot-1", name: "Ada" })
const grace = botProfile("network-grace", { id: "bot-2", name: "Grace" })

const request = (patch: Partial<NetRequest> & { id: string; at: number }): NetRequest => ({
  bots: [ada.id],
  route: "GET models",
  ms: 120,
  ending: "answered",
  status: 200,
  ...patch,
})

/** The switch root sits inside Base UI's label: the bare id belongs to a clipped hidden input. */
const switchOf = () => find("#network-log-label [data-slot='switch']")
const checkedOf = (element: Element | null) => {
  assert.ok(element, "the switch is on screen")
  return element.getAttribute("aria-checked") === "true"
}

async function seedLog() {
  await seedSettings({ developer: true })
  await db.profiles.clear()
  await db.profiles.bulkPut([ada, grace])
  await db.netLog.clear()
  await db.netLog.bulkPut([
    request({ id: "r1", at: 1_000, route: "GET models", ms: 100 }),
    request({
      id: "r2",
      at: 2_000,
      route: "POST chat/completions",
      ms: 300,
      stream: true,
      frame: 180,
      words: 2_400,
    }),
    request({
      id: "r3",
      at: 3_000,
      bots: [grace.id],
      route: "GET sessions/:id/messages",
      ms: 50_000,
      ending: "timeout",
      status: undefined,
    }),
  ])
}

test("off, the Developer switch records nothing and offers no log to read", async () => {
  await seedSettings({ developer: true })
  await db.netLog.clear()
  await db.profiles.clear()
  await db.profiles.put(ada)
  await mount(
    <MemoryRouter>
      <DeveloperSettings />
    </MemoryRouter>,
    async () => {
      assert.equal(checkedOf(switchOf()), false, "off until it is turned on")
      assert.equal(find('a[href="/settings/network"]'), null, "no log to open until it records")
      await click(switchOf())
      assert.equal(checkedOf(switchOf()), true, "and on once it is")
      assert.ok(find('a[href="/settings/network"]'), "the way into the log it now keeps")
    },
  )
  assert.equal((await db.settings.get("settings"))?.netLog, true, "the device kept the switch")
})

test("the screen reads the log a bot's requests filled", async () => {
  await seedLog()
  await mount(<NetworkLogScreen />, async () => {
    assert.match(text(), /Average/, "the strip names the number")
    assert.match(text(), /200 ms/, "the mean of the two answers")
    assert.match(text(), /1 of 3/, "one request failed")
    assert.match(text(), /Connected in/, "the stream's own wait")
    assert.match(text(), /180 ms/, "the newest stream open")
    assert.match(text(), /First words/, "the send's own wait")
    assert.match(text(), /not network time/, "and it says what it is not")
    assert.match(text(), /timed out/, "a failure reads in the app's words, not a status")
    assert.equal(findAll("tbody tr").length, 3, "every request in the log is drawn")
    assert.match(findAll("tbody tr")[0]?.textContent ?? "", /sessions\/:id\/messages|timed out/)
  })
})

test("All draws every bot and a bot's pill shows only its own", async () => {
  await seedLog()
  await mount(<NetworkLogScreen />, async () => {
    assert.equal(findAll("tbody tr").length, 3, "All is every bot")
    const pill = findAll("button").find((button) => button.textContent === "Grace")
    assert.ok(pill, "each bot the log heard from has a pill")
    await click(pill)
    assert.equal(findAll("tbody tr").length, 1, "Grace's own request")
    assert.match(text(), /0 of 1|1 of 1/, "the strip counts the selection")
    assert.doesNotMatch(text(), /POST chat\/completions/, "Ada's send is not in Grace's log")
    await click(findAll("button").find((button) => button.textContent === "All"))
    assert.equal(findAll("tbody tr").length, 3, "All again is every bot")
  })
})

test("the log keeps its newest requests and no more", async () => {
  await db.netLog.clear()
  const rows = Array.from({ length: KEPT + 60 }, (_, at) => request({ id: `r${at}`, at }))
  await db.netLog.bulkPut(rows)
  await trimNetLog()
  assert.equal(await db.netLog.count(), KEPT, "trimmed to the cap")
  const oldest = await db.netLog.orderBy("at").first()
  assert.equal(oldest?.id, "r60", "the oldest went, not the newest")
})

test("a stream's late number puts its row again without counting it twice", async () => {
  await db.netLog.clear()
  const at = (n: number) => request({ id: `r${n}`, at: n })
  await db.netLog.bulkPut(Array.from({ length: KEPT }, (_, n) => at(n)))
  // The row the stream had already written, put again with its frame: one row, not two.
  await db.netLog.bulkPut([{ ...at(KEPT - 1), stream: true, frame: 40 }])
  await trimNetLog()
  assert.equal(await db.netLog.count(), KEPT, "an exact count, so nothing is dropped past the cap")
})

test("Clear empties the log and keeps it empty", async () => {
  await db.netLog.bulkPut([request({ id: "r1", at: 1_000 })])
  await clearNetLog()
  assert.equal(await db.netLog.count(), 0, "nothing left to read")
})

test("an empty log says how to fill it rather than drawing an empty table", async () => {
  await seedSettings({ developer: true, netLog: true })
  await db.netLog.clear()
  await mount(<NetworkLogScreen />, async () => {
    assert.match(text(), /No requests recorded yet/)
    assert.equal(findAll("tbody tr").length, 0)
  })
})
