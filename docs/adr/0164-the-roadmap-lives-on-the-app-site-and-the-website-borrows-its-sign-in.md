# The roadmap lives on the app site, and the website borrows its sign-in

The website gains a Roadmap page (`/roadmap`): features an admin lists, each linked to the GitHub
issue that describes it, and one vote per feature per signed-in account. The website is a static
Astro site on its own Netlify site, with no accounts of its own. Gots's accounts are the app site's
Netlify Identity (GitHub sign-in), and so is everything else that names a person, such as the
community leaderboard.

**The decision: the roadmap is a function on the app site (`app/netlify/functions/roadmap.mts`),
read and voted on from the website across origins with the app site's own Identity token.**

- **One account system.** The website could have had its own Identity. That would mean a second
  account per person, a second admin list and a second GitHub OAuth app, for a page whose whole
  point is "one vote per account". Votes counted against the app's accounts mean one vote per
  person who signed in to Gots.
- **The token reaches the website through a bridge page on the app site**
  (`app/public/auth/website.html`), built the way the Android app's `auth/native.html` already is.
  GoTrue returns to the page that started sign-in, so the website sends the reader there with
  `?return=<page>`. The bridge keeps the return in `localStorage`, signs in with GitHub and hands
  the access token back in the return page's fragment. **It returns only to `https://hermesgots.dev`**
  (or to localhost, when the bridge itself is served from localhost). Otherwise any link could have
  a reader's token sent wherever it named. It passes on the access token and its lifetime, never
  the refresh token, so a leaked fragment is worth an hour at most.
- **The website keeps the access token and nothing else.** When the token runs out, or Identity
  declines it (a 401), the page signs the reader out. The next vote sends them through the bridge
  again, which is a click-through for anyone who already authorised the app on GitHub, and a vote
  made while signed out is cast once they are back. Refreshing across origins would have meant
  depending on GoTrue's CORS, which nothing else here relies on.
- **CORS is granted only to the named origins** (`ROADMAP_ORIGINS`, by default
  `https://hermesgots.dev`), and never with credentials. The token is the credential, so the app
  site's cookie can't ride a cross-site request. `requireUser`'s origin check for cookie writes
  stays as it is.

**A vote is a key, not a count.** `roadmap/votes/<feature>/<voter>` exists or it doesn't, so voting
twice writes the same key, and a board's counts are those keys, listed when the board is read. No
count is stored, so none can drift from the votes it counts, and two people voting at once can't
lose one. The voter is a SHA-256 of the Identity account id, so the store (`gots-roadmap`) holds
nothing that names a person. That keeps to the rule the community leaderboard set for anything
public on Netlify. The feature list is one document, written only by an admin on the etag it read.

**An admin is an account with the Identity role `admin`**, which the site's owner gives in Netlify's
Identity settings (`app_metadata.roles`). It isn't the GitHub id in the account's avatar, which is
how the community function finds a person: GoTrue lets any signed-in user rewrite their own
`user_metadata` with `PUT /user`, avatar included, so anything read from there could be claimed by
anyone. A role needs no admin screen of its own and no environment variable. With nobody given the
role, nobody can edit the roadmap, and everybody can still read and vote.

**A feature is its issue.** An admin gives an issue link (required, `github.com/<owner>/<repo>/issues/<n>`).
The title is the issue's own, read from GitHub, unless one is given. An issue is listed once. The
page opens the issue when the feature is tapped, so the issue is the feature's details and nothing
is written twice. Shipped features stay on the board under their own heading, and stop taking votes.

Not built: comments, suggestions from readers, and votes on the app's own screens.
