# A GitHub id is stamped at signup

**The question:** the community leaderboard names a person by their GitHub username and nothing else,
and promises that nobody can claim someone else's. `POST community?route=join` kept that promise by
reading the GitHub account id out of the sign-in's avatar URL (`avatars.githubusercontent.com/u/<id>`)
and asking GitHub for that id's login. The avatar is `@netlify/identity`'s `User.pictureUrl`, which is
`user_metadata.avatar_url`, and on the Bearer path `requireUser` read the same field out of GoTrue's
`GET /user`.

`user_metadata` is the user's own. GoTrue's `PUT /user` writes `{ data }` into it for any signed-in
caller with no check (`api/user.go`, `UpdateUserMetaData`), so a user could set their avatar to
another person's GitHub avatar URL, join, and put their token counts under that person's name on a
public page. `app_metadata` is admin-only — the same handler refuses `app_metadata` without admin
rights ("Updating app_metadata requires admin privileges") — but GoTrue writes nothing from GitHub
into it: its GitHub provider (`api/provider/github.go`) keeps only the name and avatar, both in
`user_metadata`, finds a returning user by verified email, and leaves `app_metadata` holding
`provider: "github"`. There is no `identities` array in Netlify's GoTrue, and the JWT carries the same
two maps. Checked against `netlify/gotrue` `master` on 2026-11-17.

**The decision: copy the id into `app_metadata` at the one moment `user_metadata` is GitHub's own —
the signup — and read it from there ever after.** When GitHub creates a new user, GoTrue fills
`user_metadata` from GitHub's answer and calls the site's signup hook inside the same transaction,
before the user holds a session (`api/external.go`, `triggerEventHooks(SignupEvent)`), and it applies
the `app_metadata` the hook answers with (`api/hooks.go`). So `identity-signup` reads the id out of the
avatar GoTrue just wrote and answers `app_metadata` with `github_id` added. `requireUser` returns
`app_metadata.github_id` (and `app_metadata.roles`) on its cookie and Bearer paths alike, the join
asks GitHub for that id's login, and nothing reads identity or privilege from `user_metadata`.
Signing in stays one GitHub sign-in, and joining stays one tap.

- **Only a GitHub signup is stamped.** `app_metadata.provider` is GoTrue's own word. An email signup
  can carry any `user_metadata` its caller typed — a forged avatar included — and its provider is
  `email`, so it is left alone.
- **The hook carries `app_metadata` back whole.** GoTrue clears `app_metadata` before writing the
  hook's answer (`user.AppMetaData = nil`), so the answer is the user's own map with `github_id`
  added, `provider` and any `roles` included.
- **The hook writes nothing and never fails.** It is a public function URL, so anyone can call it; it
  only answers a body, which nobody applies but GoTrue. GoTrue refuses the signup on any status but
  200, 202 or 204, so anything it can't read is a 204 that leaves the user as GoTrue made it.
- **Nothing new is stored on Netlify's own stores.** The id sits on the Identity account, where the
  avatar URL that names it already sat, and the leaderboard's stores gain only `verifiedAt` on an
  account and `verified` on its owner record.

The other routes were rejected: proving the username with GitHub's OAuth device flow (this ADR's
first draft) works but asks a user who just signed in with GitHub to go back and approve a code; and
running GitHub sign-in through the site's own OAuth app instead of Identity would also give a
trustworthy id, at the price of taking over sessions, the Android sign-in and a migration of every
account's id, which the vault's documents are sealed under.

**Accounts that signed up before the hook carry no `github_id`, and nothing they hold can give one.**
Their accounts on the board carry no `verifiedAt` and their owner records no `verified`, and that
absence is the mark. Their hosts keep reporting into the private store, but no public record is
written for them, and `GET board` drops and deletes any `users/<login>` record without
`verified: true`, which takes every pre-existing record off the board at its next build. `GET me`
answers `verified: false` and Settings offers *Confirm your GitHub username*, which joins again — and
that join succeeds once the account carries a `github_id`. A join that verifies rebuilds the public
record from the account's own reports under the login GitHub named, and a verified claim beats an
unverified one: when the real owner of a login joins, the account an avatar had joined under that
login is taken out of the leaderboard as Leave would take it, its reports with it. A verified claim
is never overridden.

**The backfill is an admin's.** `GET community?route=unstamped` lists the Identity accounts with no
`github_id`, each with the id its avatar claims, and `POST community?route=stamp` `{ userId, githubId }`
writes one through Identity's admin API (an admin update merges into `app_metadata`), refusing to
change an id already stamped unless asked with `replace`. Both need the Identity role `admin`, which
lives in `app_metadata.roles` and only Netlify's settings grant. `pnpm community-stamp` walks the list
and asks the operator, account by account, which GitHub account each belongs to: the avatar's claim
is shown as a claim, since a person you know is the only proof an old account can have.

**What this costs and what is unverified.** Function hooks are found by name: `identity-signup` is
Netlify's documented name for the signup hook, and that it is wired for a Functions 2.0 default
export was not checked against Netlify's documentation, which this change was written without
reaching — one test signup on a branch deploy settles both. Netlify's hosted Identity may differ from
the open-source GoTrue read here. An account an admin stamps wrongly puts that login on the wrong
person, so the backfill is only as good as the operator's knowledge of each account. A user who
renames their GitHub account keeps their place under the old login until they leave and join again,
as before.
