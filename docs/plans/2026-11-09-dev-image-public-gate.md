# The dev image is public, and proves it carries gh

## Goals
- **G1** `docker pull ghcr.io/thehaseebahmed/gots-dev:latest` works for a machine that is not logged in, so the
  sandbox that runs Gots — `docker_image: ghcr.io/thehaseebahmed/gots-dev` in the host's Hermes config — gets the
  current image instead of the stale local copy it runs today.
- **G2** The image's own verification proves `gh` and the rest of the tools the image promises resolve from a login
  shell, so an image without `gh` on `PATH` cannot be published again.

## Non-goals
- Flipping the package's visibility from CI: the token this environment holds (`gotsfather`) has no admin on a package
  owned by `thehaseebahmed`, so the click is the owner's (see Decisions).
- Pinning the sandbox to a digest, or otherwise editing the Hermes config outside this repository.
- `.devcontainer/devcontainer.json`, the single owner for the toolchain versions, and a non-root image — all three are
  already recorded in `fixes.md` and #230's notes as decisions of their own.

## Change map
| Layer | Status | Goals | Tested at |
|---|---|---|---|
| The registry probe (`.github/scripts/ghcr-public.sh`) | new | G1 | its own run against a public control |
| Image distribution (`.github/workflows/dev-image.yml`) | changed | G1 G2 | `bash .github/scripts/ghcr-public.sh …` and the smoke run |
| Contributor docs (`CONTRIBUTING.md`) | changed | G1 G2 | read-through against the workflow's tags |

## Flows
### F1: what was published is proved pullable (changed). Test: `ghcr-public.sh` against `gots-dev` (red) and a public package (green)
```mermaid
sequenceDiagram
  participant WF as Dev image workflow
  participant Reg as ghcr.io
  WF->>Reg: docker push ghcr.io/…/gots-dev:sha-<short> and :latest
  rect rgb(255, 245, 200)
  WF->>Reg: anonymous token for repository:…/gots-dev:pull
  Reg-->>WF: a token, or 401
  WF->>Reg: GET /v2/…/gots-dev/manifests/latest with it
  Reg-->>WF: 200, or 401
  end
  WF-->>WF: green, or red naming the package's settings page
```

### F2: a tool the image promises is callable (changed). Test: the smoke run in the Verify step
```mermaid
sequenceDiagram
  participant WF as Dev image workflow
  participant Img as the built image
  WF->>Img: docker run … bash -lc 'command -v gh …'
  rect rgb(255, 245, 200)
  Img->>Img: /etc/profile builds PATH for a login shell
  Img-->>WF: each tool's path, or "missing from PATH: gh"
  end
```

## Steps
1. **The probe: is this image pullable without credentials?** A script that asks ghcr.io for an anonymous pull token and
   the tag's manifest, exiting 0 with the manifest's digest and 1 with the package's settings URL. Goals: G1. After: none.
   Check: red before the flip — `bash .github/scripts/ghcr-public.sh ghcr.io/thehaseebahmed/gots-dev:latest` exits 1
   naming the settings page — green after it (a digest), with `ghcr.io/renovatebot/renovate:latest` green as the control
   and an unpublished name red.

   Done.
2. **A publish proves it.** The Dev image workflow runs the probe over every tag it pushed, on the paths that publish —
   a `main` push or a dispatch. Goals: G1. After: 1. Check: step 1's command is the step's command; a pull request
   publishes nothing and is skipped by the same condition Publish uses.

   Done.
3. **The image proves its tools.** The Verify step runs `bash -lc` inside the image and fails on the first tool that is
   missing, naming it. Goals: G2. After: none. Check: the same command in this container — a stale build of the same
   image — reports `missing from PATH: gh` and `reticle`, which is the failure it has to catch, while the image CI
   builds must exit 0.
4. **`CONTRIBUTING.md` says what the image carries and what a refused pull means.** Goals: G1 G2. After: none. Check:
   read-through — the tool list names the GitHub CLI, and the pull section says the package is public and links the
   settings where that was changed.

## Decisions
- **The visibility flip is the package owner's, not the workflow's.** Made by the agent, because the token available
  here (`gotsfather`) gets `404` from `PATCH /users/thehaseebahmed/packages/container/gots-dev`, while an anonymous pull
  token is refused (`401`) and a public control's is granted (`200` with a manifest) — the API cannot make a package
  its user does not own public.
- **The pullability probe runs where something publishes.** Made by the agent: on a pull request nothing is pushed, so
  the probe would test the package as it stands and go red for a reason the pull request cannot fix.
- **The smoke run uses a login shell (`bash -lc`).** Made by the agent: Debian's `/etc/profile` rebuilds `PATH` for
  login shells, the trap the Dockerfile already records for `python3`, so the harsher shell is the honest one.

## Risks
- The first `main` run after this merge is red until the package is flipped. The Dev image workflow is path-filtered and
  is not a required check, so nothing else is blocked by it — but the red is the point, not an accident.
- The probe depends on ghcr.io's anonymous token endpoint. If that changes shape, the step fails and prints the URL
  rather than passing quietly.
- This pull request cannot make the pull work on its own: between the merge and the flip, the sandbox still runs the
  stale image, and one `docker pull` is needed after the flip to replace it.

## Not now
- `.devcontainer/devcontainer.json`, from `fixes.md` — "No artefact owns the container invocation".
- One owner for the toolchain versions, from `fixes.md` — "The toolchain versions have no single owner".
- A non-root image, from #230's notes for reviewers.
