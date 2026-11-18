/**
 * The chat's bot picker, named by the bots' own names: two linked hosts call their default profile
 * "Hermes", so the picker says which host each is only where two namesakes live apart — and a name
 * nobody shares stands alone (`bot-name.ts`, ADR 0149). Its rows run by name, not by the order the
 * bots were linked in. The model picker's rows are here too: a score a model draws is a fact of the
 * payload the build ships (`rankings-data.ts`), which is what the deleted BenchLM function answered.
 */
import assert from "node:assert/strict"
import test from "node:test"
import { useState, type ReactNode } from "react"

import { BotPicker } from "@/components/chat/bot-picker"
import { ModelMenu, ModelPicker } from "@/components/chat/model-picker"
import { Popup, PopupContent } from "@/components/popup"
import { db } from "@/lib/db"
import { useModelInfo } from "@/lib/model-info"
import { scoreFor, scoreMapOf } from "@/lib/model-match"
import { RANKINGS } from "@/lib/rankings-data"

import {
  botProfile,
  click,
  find,
  findAll,
  json,
  mount,
  seedSettings,
  settle,
  text,
  until,
  wordsOf,
  withToasts,
} from "./component-kit.tsx"

const bot = (id: string, host: string, path = "/v1", name = "Hermes") =>
  botProfile(host, { id, name, baseUrl: `https://${host}${path}` })

/** The device holds these bots, turned on, with the first of them the account's active one. */
async function seed(bots: ReturnType<typeof bot>[]) {
  await seedSettings({ activeProfileId: bots[0].id })
  await db.profiles.clear()
  await db.profiles.bulkPut(bots)
}

const picker = (one: ReturnType<typeof bot>) => <BotPicker profile={one} />

/**
 * The model picker's sheet as a caller holds it open, the way every screen that opens one does: the
 * sheet's own close has to be able to put it away, which a pop-up mounted with a hardcoded `open`
 * never shows.
 */
const OpenedPicker = ({ children }: { children: ReactNode }) => {
  const [open, setOpen] = useState(true)
  return (
    <Popup open={open} onOpenChange={setOpen}>
      <PopupContent>{children}</PopupContent>
    </Popup>
  )
}

test("two hosts' sealed defaults say which host each is, and a name nobody shares stands alone", async () => {
  // Linked in an order no list draws: the rows prove the order comes from the labels.
  const bots = [
    bot("c", "notes.third.dev", "/v1", "Notes"),
    bot("a", "hermes.domain.com"),
    bot("b", "hermes.example.com"),
  ]
  await seed(bots)
  await mount(picker(bots[1]), async () => {
    const pill = () => document.querySelector('button[aria-label^="Bot: "]')
    await until(async () => Boolean(pill()), "the picker's pill")
    assert.equal(
      pill()!.getAttribute("aria-label"),
      "Bot: Hermes (domain)",
      "the pill names the bot, and the host that tells it from its namesake",
    )
    await click(pill())
    await until(
      async () => findAll('[role="menuitemradio"]').length === 3,
      "the picker's three bots",
    )
    assert.deepEqual(
      findAll('[role="menuitemradio"]').map((one) => wordsOf(one)),
      ["Hermes (domain)", "Hermes (example)", "Notes"],
      "the two hosts sharing one name read as their domain parts, a name alone reads bare, and the "
        + "rows run A to Z",
    )
    assert.equal(
      findAll('[role="menuitemradio"]').filter((one) => wordsOf(one) === "Hermes").length,
      0,
      "a name two hosts share is never drawn without the host that tells them apart",
    )
    await settle()
  })
})

test("the rows run by name, and one host's several bots read by their own names", async () => {
  const bots = [
    bot("a", "hermes.domain.com"),
    bot("b", "hermes.domain.com", "/p/work/v1", "work"),
    bot("c", "hermes.example.com"),
  ]
  await seed(bots)
  await mount(picker(bots[0]), async () => {
    const pill = () => document.querySelector('button[aria-label^="Bot: "]')
    await until(async () => Boolean(pill()), "the picker's pill")
    await click(pill())
    await until(
      async () => findAll('[role="menuitemradio"]').length === 3,
      "the picker's three bots",
    )
    assert.deepEqual(
      findAll('[role="menuitemradio"]').map((one) => wordsOf(one)),
      ["Hermes (domain)", "Hermes (example)", "work"],
      "the second bot of one host is its own name, and the two sealed defaults still say their hosts",
    )
    await settle()
  })
})

test("a name two bots of one host share is drawn without the host", async () => {
  const bots = [
    bot("a", "hermes.domain.com"),
    bot("b", "hermes.domain.com", "/p/work/v1"),
  ]
  await seed(bots)
  await mount(picker(bots[0]), async () => {
    const pill = () => document.querySelector('button[aria-label^="Bot: "]')
    await until(async () => Boolean(pill()), "the picker's pill")
    await click(pill())
    await until(
      async () => findAll('[role="menuitemradio"]').length === 2,
      "the picker's two bots",
    )
    assert.deepEqual(
      findAll('[role="menuitemradio"]').map((one) => wordsOf(one)),
      ["Hermes", "Hermes"],
      "one host tells the two apart from nothing, so it is not drawn",
    )
    await settle()
  })
})

/**
 * The picker's scores come from the payload the build ships (`src/lib/rankings-data.ts`), the one
 * thing the deleted BenchLM function used to answer: a ranked model draws its score on the first
 * paint, and a model the payload has no row for says so rather than showing nothing.
 */
test("the picker scores a model from the shipped payload", async () => {
  // models.dev's facts for both models, so a row draws its second line at all.
  await db.modelsDevCatalog.put({
    id: "catalog",
    etag: "test",
    fetchedAt: Date.now(),
    data: {
      anthropic: {
        models: {
          "claude-sonnet-4-6": { limit: { context: 200_000 }, cost: { input: 3, output: 15 } },
          "deepseek-v4-flash": { limit: { context: 128_000 }, cost: { input: 0.2, output: 0.8 } },
        },
      },
    },
  })
  await mount(
    <Popup open>
      <PopupContent>
        <ModelPicker
          header={false}
          providers={[
            {
              slug: "anthropic",
              name: "Anthropic",
              models: ["claude-sonnet-4-6", "deepseek-v4-flash"],
            },
          ]}
          fallback={{ label: "The bot's default" }}
          onChoose={() => {}}
        />
      </PopupContent>
    </Popup>,
    async () => {
      await until(async () => text().includes("claude-sonnet-4-6"), "the picker's model rows")
      const scored = scoreFor(scoreMapOf(RANKINGS.items), "claude-sonnet-4-6")
      assert.ok(scored !== undefined, "the shipped payload ranks claude-sonnet-4-6")
      const line = (model: string) =>
        wordsOf(findAll("li").find((row) => wordsOf(row).includes(model)) ?? null)
      assert.match(
        line("claude-sonnet-4-6"),
        new RegExp(`BenchLM ${Math.round(scored)}\\b`),
        "a model the shipped payload ranks draws its score",
      )
      assert.match(
        line("deepseek-v4-flash"),
        /BenchLM \?/,
        "a model it has no row for says so",
      )
      await settle()
    },
  )
})

/**
 * A host with one provider has nothing to choose between, so its models show at once — under the
 * provider's own name, in the picker's own layer. A provider the reader opened stacks a sheet over
 * that layer; one the picker drilled into on its own must not, or the models are drawn twice and the
 * layer standing over the list has no way back.
 */
test("a host with one provider draws its models once, and its sheet is put away by its close", async () => {
  await mount(
    <OpenedPicker>
      <ModelPicker
        providers={[
          {
            slug: "anthropic",
            name: "Anthropic",
            models: ["claude-sonnet-4-6", "deepseek-v4-flash"],
          },
        ]}
        fallback={{ label: "Default" }}
        onChoose={() => {}}
      />
    </OpenedPicker>,
    async () => {
      const layers = () => findAll("[data-popup-form]")
      await until(async () => text().includes("claude-sonnet-4-6"), "the picker's model rows")
      assert.equal(layers().length, 1, "one layer, not one stacked over the picker's own")
      assert.equal(
        wordsOf(layers()[0].querySelector('[data-slot="sheet-title"]')),
        "Anthropic",
        "the picker's own header names the provider",
      )
      const rows = (model: string) => findAll("li").filter((row) => wordsOf(row).includes(model))
      assert.equal(
        rows("claude-sonnet-4-6").length,
        1,
        "each model is one row, not one in each of two layers",
      )
      assert.equal(rows("deepseek-v4-flash").length, 1, "and so is the host's other model")
      // The sheet's own close, the ordinary way out: with a second layer standing over the list,
      // pressing it only clears the provider the reader opened and the stacked sheet opens again.
      await click(document.querySelector('button[aria-label="Close"]'))
      await until(async () => layers().length === 0, "the sheet is put away")
    },
  )
})

/**
 * The headers' refresh. The picker is driven through `ModelMenu`, which reads the host's models
 * through `useModelInfo`: a press has to drop that cached answer for the list on screen to repaint,
 * which a picker handed its providers as props would never show.
 */
const ONE_PROVIDER = [{ slug: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-6"] }]

/** A host answering `/api/model/options`, recording every query it was asked with. */
function modelsHost({
  providers = ONE_PROVIDER,
  added,
  refuseRefresh = false,
  hold,
  refreshedModel,
  unprobed,
}: {
  providers?: { slug: string; name: string; models: string[] }[]
  /** The model the host adds to its list once it has been asked to read it again. */
  added?: string
  refuseRefresh?: boolean
  /**
   * A promise the first plain read waits on before it answers, so a case can hold that read out
   * past a refresh and release it once the refresh has repainted.
   */
  hold?: Promise<void> | null
  /** The main model the host answers with once it has been asked to read its models again. */
  refreshedModel?: string
  /**
   * Whether the host also holds a custom endpoint it has not probed: a row with an `api_url` and
   * no models, beside the providers it lists. Hermes lists such an endpoint's models only once it
   * has probed it, which is what a plain read does not do.
   */
  unprobed?: boolean
} = {}) {
  const asked: string[] = []
  let refreshed = false
  let held = false
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    if (!url.pathname.endsWith("/api/model/options")) return json({})
    asked.push(url.search)
    if (url.searchParams.get("refresh")) {
      // A host that never answers: the refresh gets nothing back, so the cache keeps what it had.
      if (refuseRefresh) return json({ error: { message: "The host is busy." } }, 500)
      refreshed = true
    }
    // What the host answers is what it holds when it is asked, not when it finishes answering, so a
    // read held out past a refresh carries the list as it was when that read went out.
    const body = {
      model: refreshed && refreshedModel ? refreshedModel : "claude-sonnet-4-6",
      provider: "anthropic",
      providers: unprobed
        ? [
            ...providers.map((one) => ({
              ...one,
              models:
                refreshed && added && one.slug === "anthropic"
                  ? [...one.models, added]
                  : one.models,
            })),
            {
              slug: "custom",
              name: "Custom",
              api_url: "https://openrouter.example/v1",
              models: [],
            },
          ]
        : providers.map((one) => ({
            ...one,
            models:
              refreshed && added && one.slug === "anthropic" ? [...one.models, added] : one.models,
          })),
    }
    // A refresh read answers at once; the plain read a case holds out waits on its promise.
    if (hold && !held && !url.searchParams.get("refresh")) {
      held = true
      await hold
    }
    return json(body)
  }) as unknown as typeof fetch
  return {
    asked,
    /** Every plain read of the list: a refresh is a read of its own, and not one of these. */
    reads: () => asked.filter((search) => !search.includes("refresh")).length,
    /** Every full probe of the host's endpoints, which a refresh asks for. */
    probes: () => asked.filter((search) => search.includes("refresh")).length,
  }
}

const pill = () => document.querySelector('button[aria-label^="Model: "]')
const refresh = () => find('[aria-label="Refresh models"]')
/** The header of the layer standing in front, which over the picker's own is a provider's sheet. */
const frontHeader = () =>
  findAll("[data-popup-form]").at(-1)?.querySelector('[data-slot="sheet-header"]') ?? null

/**
 * A header's refresh reaches a one-provider host's models on the five surfaces that pass
 * `header={false}` too: with one provider there is nothing to choose between, so the picker drills
 * into it and its models stand under a header of their own — the one carrying the refresh.
 */
test("a one-provider host's own header carries the refresh where the surface draws no header", async () => {
  modelsHost()
  await mount(
    <OpenedPicker>
      <ModelPicker
        header={false}
        profile={botProfile("one-provider-header.test")}
        providers={[
          {
            slug: "anthropic",
            name: "Anthropic",
            models: ["claude-sonnet-4-6", "deepseek-v4-flash"],
          },
        ]}
        fallback={{ label: "Default" }}
        onChoose={() => {}}
      />
    </OpenedPicker>,
    async () => {
      await until(async () => Boolean(refresh()), "the header's refresh")
      assert.equal(
        wordsOf(frontHeader()?.querySelector('[data-slot="sheet-title"]') ?? null),
        "Anthropic",
        "the header names the provider whose models it heads",
      )
    },
  )
})

test("a header's refresh reads the host's models again, and the list repaints with them", async () => {
  const host = modelsHost({ added: "claude-opus-4-5" })
  await mount(
    <ModelMenu profile={botProfile("refresh-host.test")} onChoose={() => {}} />,
    async () => {
      await until(async () => Boolean(pill()), "the composer's model pill")
      await click(pill())
      await until(async () => Boolean(refresh()), "the picker's own header")
      assert.equal(host.reads(), 1, "the host's list was read once, for the models on screen")
      await click(refresh())
      await until(async () => text().includes("claude-opus-4-5"), "the model the host added")
      assert.ok(
        host.asked.some((search) => search.includes("refresh=true")),
        "the host was asked to read its models again",
      )
      assert.equal(host.reads(), 2, "and the picker read the new answer back off the host")
    },
  )
})

test("a provider's header carries the refresh too", async () => {
  modelsHost({
    providers: [
      { slug: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-6"] },
      { slug: "openrouter", name: "OpenRouter", models: ["deepseek-v4-flash"] },
    ],
  })
  await mount(
    <ModelMenu profile={botProfile("refresh-two.test")} onChoose={() => {}} />,
    async () => {
      await until(async () => Boolean(pill()), "the composer's model pill")
      await click(pill())
      await until(async () => Boolean(refresh()), "the picker's own header")
      await click(findAll("button").find((one) => wordsOf(one).startsWith("Anthropic")) ?? null)
      await until(async () => Boolean(frontHeader()), "the provider's own sheet")
      assert.ok(
        frontHeader()?.querySelector('[aria-label="Refresh models"]'),
        "the provider's header carries the refresh at its right",
      )
      assert.equal(
        wordsOf(frontHeader()?.querySelector('[data-slot="sheet-title"]') ?? null),
        "Anthropic",
        "the sheet standing in front is that provider's own, under its name",
      )
    },
  )
})

/**
 * A read still out when a refresh lands must not answer after it. The host holds the first plain
 * read open — a promise the case releases once the refresh has repainted — and answers the refresh
 * at once, with a model the held read never saw. The picker is driven over the read every surface
 * makes for it rather than through `ModelMenu`, whose pill stays disabled until that read lands:
 * the first read cannot be held out with the pill's picker open.
 */
test("a read still out when a refresh lands doesn't answer after it", async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  modelsHost({ added: "claude-opus-4-5", refreshedModel: "claude-opus-4-5", hold: held })
  const profile = botProfile("race-host.test")
  await db.profiles.clear()
  await db.profiles.put(profile)
  const Reading = () => {
    const info = useModelInfo(profile)
    return (
      <OpenedPicker>
        <ModelPicker
          providers={info?.providers ?? []}
          fallback={{ label: "Default" }}
          onChoose={() => {}}
          profile={profile}
        />
      </OpenedPicker>
    )
  }
  await mount(<Reading />, async () => {
    await until(async () => Boolean(refresh()), "the picker's own header")
    // The first read is still out: what the refresh answers is the answer the cache comes to hold.
    await click(refresh())
    await until(async () => text().includes("claude-opus-4-5"), "the model the host added")
    // The held read lands now, after the refresh's answer is the connection's current one.
    release()
    await settle()
    assert.ok(
      text().includes("claude-opus-4-5"),
      "the model the host added is still on the list",
    )
    const saved = await db.profiles.get(profile.id)
    assert.equal(
      saved?.hostModel?.model,
      "claude-opus-4-5",
      "the bot's remembered host model is the one the refresh answered, not the held read's",
    )
  })
})

/**
 * A refresh probes every endpoint on the host, so the re-read it causes must not probe again. The
 * host holds a custom endpoint that still comes back empty, and its escalation throttle has lapsed
 * since it was last probed in full: the re-read would otherwise ask for a second full probe for an
 * answer the refresh has just gone and got.
 */
test("a refresh's re-read doesn't ask the host for a second full probe", async () => {
  const host = modelsHost({ unprobed: true })
  await mount(
    <ModelMenu profile={botProfile("unprobed-host.test")} onChoose={() => {}} />,
    async () => {
      await until(async () => Boolean(pill()), "the composer's model pill")
      await click(pill())
      await until(async () => Boolean(refresh()), "the picker's own header")
      // The throttle's window has lapsed since the host was last probed in full.
      const real = Date.now
      Date.now = () => real() + 11 * 60_000
      try {
        const probes = host.probes()
        const reads = host.reads()
        await click(refresh())
        // Both the press's own probe and the re-read it causes have to land before the count is read.
        await until(async () => host.reads() > reads, "the re-read the refresh causes")
        await settle()
        assert.equal(
          host.probes() - probes,
          1,
          "one press asks the host for one full probe, not two",
        )
      } finally {
        Date.now = real
      }
      assert.ok(
        text().includes("claude-sonnet-4-6"),
        "the host's models are still on the list",
      )
    },
  )
})

test("a host that doesn't answer keeps the list and says so", async () => {
  const host = modelsHost({ refuseRefresh: true })
  await withToasts(async (said) => {
    await mount(
      <ModelMenu profile={botProfile("refresh-away.test")} onChoose={() => {}} />,
      async () => {
        await until(async () => Boolean(pill()), "the composer's model pill")
        await click(pill())
        await until(async () => Boolean(refresh()), "the picker's own header")
        const reads = host.reads()
        await click(refresh())
        await until(async () => said.length > 0, "the sentence")
        assert.deepEqual(said, ["Couldn't refresh this bot's models."])
        assert.equal(host.reads(), reads, "no further read lands, so the list is untouched")
        assert.ok(
          text().includes("claude-sonnet-4-6"),
          "the model the host listed is still on the list",
        )
      },
    )
  })
})
