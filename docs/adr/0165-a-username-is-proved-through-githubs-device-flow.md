# A username is proved through GitHub's device flow

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
rights ("Updating app_metadata requires admin privileges") — but it can't stand in: GoTrue's GitHub
provider (`api/provider/github.go`) keeps only the name and avatar, both in `user_metadata`, and finds
a returning user by verified email, while `app_metadata` holds nothing from GitHub beyond
`provider: "github"`. There is no `identities` array in Netlify's GoTrue, and the JWT carries the same
two maps. Checked against `netlify/gotrue` `master` on 2026-11-17. **Netlify Identity holds no GitHub
id a user can't edit**, so no reading of it can fix this.

**The decision: the username is the one GitHub itself answers for, through GitHub's OAuth device
flow on the site's own OAuth app.** `POST join` opens a flow (`POST github.com/login/device/code` with
`GITHUB_OAUTH_CLIENT_ID`) and answers the app the user code and `github.com/login/device`; the user
approves it on GitHub; `POST join-poll` redeems the device code
(`POST github.com/login/oauth/access_token`) and reads `GET api.github.com/user` with the token it
gets. The login GitHub answers there is the one recorded. The device flow over a redirect because it
needs no client secret and no callback page, and it works the same in a browser and in the Android
app, which would otherwise need a Custom Tab and a `gots://` return of its own.

- **The device code never leaves the server.** It is kept under `community/verify/<userId>` in the
  private registry store and the app is shown only the user code, so the flow can be finished only by
  the account that opened it: nobody else can redeem a code someone else approved.
- **The server keeps GitHub's pace.** A poll before the flow's interval has passed answers `pending`
  without asking GitHub, and a `slow_down` lengthens the interval, so a client polling fast can't spend
  the site's rate limit. A second `join` while a flow is open hands back the same code.
- **No scope, and the token is dropped.** The flow asks for no scope, which still lets the token read
  `GET /user`; it is used for that one read and never stored. Revoking it needs the client secret, which
  the device flow doesn't have, so it lapses on GitHub's own terms. A scopeless token reads only what is
  public about the user.
- **Nothing from Identity names a GitHub account any more.** `requireUser` answers `{ id }` alone on
  both its cookie and its Bearer path, so no function can be handed the avatar by accident, and nothing
  reads identity or privilege from `user_metadata`. A role check belongs in `app_metadata.roles`, which
  only an admin writes.
- **Nothing new is stored about a person.** The private store gains the device flow while it is open
  and `verifiedAt` on the account; the GitHub numeric id is not kept, so a login renamed on GitHub
  stays under its old name until the member leaves and joins again, as before.

**Members who joined before: off the board until they verify.** None of their logins can be trusted
after the fact: each was whatever the avatar said. Their accounts carry no `verifiedAt` and their owner
records no `verified`, and that absence is the mark. Their hosts keep reporting into the private store,
so nothing is lost; but no public record is written for them, and `GET board` drops and deletes any
`users/<login>` record without `verified: true`, which takes every pre-existing record off the board at
its next build. `GET me` answers `verified: false`, and Settings offers *Confirm your GitHub username*.
Verifying rebuilds the public record from the account's own reports under the login GitHub named —
which may differ from the one its avatar claimed, in which case the old claim and its record go. A
verified claim beats an unverified one: when the real owner of a login verifies, the account an avatar
had joined under that login is taken out of the leaderboard the way Leave would take it, its reports
with it, and its hosts are told to stop on their next check-in. A verified claim is never overridden.

Silently trusting the old members was rejected, since it leaves exactly the forgeries this fixes on a
public page. Deleting them outright was rejected too, since it costs every honest member their history
for something they didn't do. A grace period was rejected because a forged entry would stay public for
all of it.

**What this costs.** Joining is two steps where it was one: the setup wizard and Settings show the code
and an *Open GitHub* button, and the step moves on once GitHub answers. The site needs an OAuth app
with Device Flow enabled and its client id in `GITHUB_OAUTH_CLIENT_ID`; without it joining answers
503. GitHub caps code submissions at 50 an hour per app. A device flow can still be phished: an
attacker who gets a victim to type the attacker's code on GitHub's consent page, which names the app,
puts the victim's login on the attacker's account. That needs the victim's own action on GitHub,
where the old hole needed nothing but a field of the attacker's profile. Because a verified claim is
never overridden, a victim of that can't take the login back from the app; clearing it is an
operator's deletion of the owner record.
