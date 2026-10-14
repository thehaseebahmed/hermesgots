import type { ReactNode } from "react"

const UPDATED = "14 October 2026"
const REPO = "https://github.com/thehaseebahmed/memento"

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {children}
    </section>
  )
}

function List({ children }: { children: ReactNode }) {
  return (
    <ul className="flex list-disc flex-col gap-2 pl-5 marker:text-muted-foreground">{children}</ul>
  )
}

function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-4">
      {children}
    </a>
  )
}

/** The privacy policy, shown at `/privacy` and as a Settings section. Keep it true to the code. */
export function PrivacyPolicy() {
  return (
    <article className="flex flex-col gap-8 text-base leading-relaxed [&_p]:text-pretty">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">Last updated {UPDATED}</p>
        <p>
          Memento is an open-source app for talking to your own Hermes Agent. Your chats go between
          this device and your Hermes host. They never pass through Memento&apos;s servers.
        </p>
        <List>
          <li>
            Signing in with GitHub gives Memento your name, email address and profile picture.
            Nothing else from GitHub.
          </li>
          <li>
            What Memento&apos;s server stores about your bots is encrypted on your device first. It
            can&apos;t read your bots&apos; addresses or API keys.
          </li>
          <li>Your chats, files, projects and chat list stay on your Hermes host.</li>
          <li>There are no ads, analytics or trackers, and nothing is sold.</li>
        </List>
      </div>

      <Section title="Signing in with GitHub">
        <p>
          Sign-in goes through Netlify Identity, which asks GitHub for read-only access to your
          email addresses (the <code>user:email</code> permission). Netlify keeps your email
          address, name and profile picture link, and Memento shows them in Settings. Memento
          doesn&apos;t get access to your repositories, and it never uses your sign-in to act on
          GitHub.
        </p>
        <p>
          Sign-in only tells Memento whose data is whose. It keeps you signed in on this device
          until you sign out.
        </p>
      </Section>

      <Section title="What Memento's server stores">
        <p>
          The app is hosted on Netlify, and a small part of it runs there: sync and the bot
          registry. Like any web host, Netlify sees your IP address and which pages and functions
          you load.
        </p>
        <p>
          <strong>Sync.</strong> When you turn on sync, your device makes a random key and encrypts
          your bot settings (names, characters, default models, addresses and API keys) with it
          before uploading them. That key is locked with your passkey or your recovery code, neither
          of which leaves your device. The server holds only the encrypted data, plus what it needs
          to hand it back: your account id, the salts and passkey ids that unlock it, and the public
          half of your inbox key.
        </p>
        <p>
          <strong>Bot registry.</strong> When you link a bot, the Memento plugin on your Hermes host
          seals the bot&apos;s name, address and API key to your inbox key, so only your devices can
          open it. The registry keeps that sealed record, and in the clear: which of your hosts
          published it, whether you turned the bot off, when the plugin last checked in and its
          version, and a hash of each link code and host token, never the codes or tokens
          themselves. For each Android device that gets notifications it also keeps the
          device&apos;s Firebase token and which kinds of notification you picked.
        </p>
        <p>
          <strong>Model rankings.</strong> The model picker shows a public coding ranking. The
          server fetches it from BenchLM, keeps one shared copy for a few hours and hands it out to
          everyone. It holds nothing about you, and your request for it carries nothing but what any
          web request does.
        </p>
        <p>
          Chats, messages, files, projects and research are never sent to Memento&apos;s server. The
          one thing close to them that passes through it is the name on an Android notification (see
          Notifications below).
        </p>
      </Section>

      <Section title="What stays on your Hermes host">
        <p>
          The Memento plugin runs on the computer that runs your Hermes Agent, which you control. It
          keeps, in the open:
        </p>
        <List>
          <li>
            Your chat list (titles, dates and which Hermes session each chat is), so every device
            sees the same chats.
          </li>
          <li>Photos and files you attach, so the agent can open them.</li>
          <li>
            Messages you queue while a reply is still running, until they&apos;re sent, so they go
            out even if the app is closed.
          </li>
          <li>
            Research missions: your question, the brief, the sources and quotes the agent found, and
            the guide, quiz or glossary written from them.
          </li>
          <li>
            Files the agent saves to a project&apos;s library, such as screenshots, charts and
            reports.
          </li>
          <li>
            Code projects: the GitHub repositories you clone, their working copies and the plans the
            agent writes.
          </li>
          <li>How much of the model&apos;s context each chat has used.</li>
          <li>
            Notification subscriptions for the browsers you turned notifications on in, and which
            kinds of notification each wants.
          </li>
          <li>Its link to your account: your account id, its host token and your inbox key.</li>
        </List>
        <p>
          Your messages themselves are stored by Hermes, as they would be without Memento, and
          Hermes sends them to the model provider you set up. Once a day the plugin deletes chats
          that were started but never used.
        </p>
        <p>
          For Code projects, the plugin uses the GitHub account already set up on your host (its{" "}
          <code>GITHUB_TOKEN</code>, <code>GH_TOKEN</code> or <code>gh</code> sign-in) to list your
          repositories, clone them, push the agent&apos;s branches, open and close pull requests,
          and check their status, including the checks on open pull requests so it can tell you when
          they fail. That token stays on your host. It&apos;s never sent to the app or to
          Memento&apos;s server.
        </p>
        <p>
          Research missions read the web from your host, through the search and page-reading
          services you&apos;ve set up for Hermes, so your question and the pages it opens go to
          them. The plugin also fetches each page a source is quoted from to check the quote. Voice
          clips are sent from the app to your host and turned into text there by its own
          faster-whisper; the clip is deleted as soon as it&apos;s transcribed and isn&apos;t sent
          to any speech service.
        </p>
      </Section>

      <Section title="What stays on this device">
        <p>
          The app keeps your bots, chats, messages, settings, unsent drafts and the photos you
          attached in this browser&apos;s storage (or the Android app&apos;s), along with your
          unlocked sync key so you don&apos;t have to unlock it each time. A voice recording stays
          here until your host has turned it into text. Local data in Settings clears all of it.
        </p>
      </Section>

      <Section title="Notifications">
        <p>
          If you turn on notifications, you choose which kinds you want. A notification names the
          chat, routine, project or research mission it&apos;s about and says what happened (a
          question is waiting, a run finished, checks are failing). It never says what was asked or
          what the reply was. A chat&apos;s name is the title you gave it, or the one Hermes made
          from your first messages, so it can hint at the topic.
        </p>
        <List>
          <li>
            In a browser, your Hermes host encrypts the message, name included, and sends it
            straight to your browser&apos;s push service (Google, Apple or Mozilla, depending on the
            browser), which can&apos;t read it.
          </li>
          <li>
            In the Android app, your host asks Memento&apos;s server to send it, and the server
            hands it to Google&apos;s Firebase Cloud Messaging. The name and the words of the
            notification are readable by Memento&apos;s server and Google on the way. The server
            doesn&apos;t keep them, but it keeps a Firebase token for each Android device you turn
            notifications on for, until you turn them off.
          </li>
        </List>
      </Section>

      <Section title="Other services the app uses">
        <List>
          <li>
            <strong>models.dev</strong>, to look up each model&apos;s context window and whether it
            takes images. The app downloads the whole list and looks up the model on your device, so
            models.dev sees only that someone downloaded it.
          </li>
          <li>
            <strong>BenchLM</strong>, for the model rankings, through Memento&apos;s server as
            described above.
          </li>
          <li>
            <strong>Send feedback</strong> in Settings opens a new GitHub issue with the app and
            plugin versions and your device (browser and system) filled in. Nothing is sent until
            you submit it on GitHub, and you can edit it first.
          </li>
        </List>
      </Section>

      <Section title="Deleting your data">
        <List>
          <li>Local data in Settings deletes everything on this device.</li>
          <li>
            Removing a bot deletes its host&apos;s records from the registry, and the plugin stops
            checking in.
          </li>
          <li>
            Deleting a chat removes it from the chat list on your host. Its messages stay in Hermes
            until you delete the session there. Deleting a research mission removes it from your
            host. The plugin can be removed with Hermes&apos;s own plugin commands.
          </li>
          <li>
            To delete your account and everything Memento&apos;s server holds for it, open an issue
            on <External href={`${REPO}/issues`}>GitHub</External>.
          </li>
        </List>
      </Section>

      <Section title="Changes and questions">
        <p>
          Memento&apos;s code is public on <External href={REPO}>GitHub</External>, so you can check
          everything on this page. If it changes, the date at the top changes too. Questions go to
          the same place.
        </p>
      </Section>
    </article>
  )
}
