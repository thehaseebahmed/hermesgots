---
name: canvas-craft
description: Use when writing or changing a canvas's HTML page — the document it has to be, the theme tokens and compiled classes, the phone-first measures, what the sandbox refuses, and how the page reads its data and calls its host.
---

A canvas is one complete HTML page. `canvas_read` what is there, write it whole with
`canvas_write`, or change it with `canvas_edit` — find-and-replace pairs where each `find` matches
exactly once, all applied or none. A build's writes land in its draft and reach the reader only
when the build publishes (ADR 0170).

## The document

One complete file: `<!doctype html>`, `<html lang="en">`, a `<head>` with `<title>` and the viewport
meta, styles in `<style>`, script in `<script>`. Under 256 KB, no secrets. A page that is not a
complete document is refused whole, so there is no half-written version to repair.

## Colour and classes

The app draws the page with its theme on `:root` as CSS variables:

`--background --foreground --card --card-foreground --primary --primary-foreground --secondary
--secondary-foreground --muted --muted-foreground --accent --accent-foreground --border
--destructive --success --warning --info --radius`

They follow the mode; a hardcoded colour breaks in dark, so spend colour on tokens — `--primary`
for what the page is for. Tailwind v4 compiles classes from the same tokens, so `bg-primary`,
`text-foreground`, `p-4`, `md:` and `dark:` work, each token also as `bg-`, `text-` and `border-`.
Only markup classes compile: a class built in a script, or a `<style>` rule, is not a utility —
`<style>` is for everything the utilities do not carry.

## Phone first

Most open on a phone: lay out for 390px, then breathe from 768px; nothing scrolls sideways.
Tappable is 44px tall, never behind hover; typed-into type is 16px. Keep the foot clear of the
bar: `env(safe-area-inset-bottom)`.

## The sandbox

- A form's submit is cancelled in place: nothing navigates, so handle the click.
- An `http(s)` link opens in the app on tap: use one when the reader should leave.
- Remote images over https are allowed; nothing else loads from outside: a `<script src>`, CDN
  `<link>`, `http://` image, `<iframe>`, `<object>`, `<embed>`, `<base>`, meta refresh or
  `url(https://…)` refuses the write whole. No `RTCPeerConnection`.

## Its data

The guide's *Its data* section is the contract: `canvas.data`'s eight calls, the shapes they answer
and the 64 MB / 256 KB caps. Nothing here changes them — read it before writing a page that stores
anything.

## The host, from the page

It reads four host shapes — `canvas.read("usage", {provider})`, `canvas.read("routines")`,
`canvas.read("projects")` and `canvas.read("sessions")` — and may call a tool its version declares
in `tools` on `canvas_write` or `canvas_edit`: `canvas.tool.call("<server>.<tool>", args)`, once
per tool. Everything else stays on the page.

## Before you call it done

Open it as the reader will: 390px and 768px, light and dark, empty and full. Check the empty,
loading and error states say what to do, that nothing scrolls sideways, and that every token
follows the mode. `plugin/canvas/DESIGN.md` is the design system; `gots:impeccable`,
`gots:web-design-guidelines` and `gots:transitions-dev` carry the design craft, the review rules
and the motion.
