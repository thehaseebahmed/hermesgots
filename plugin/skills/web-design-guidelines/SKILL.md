---
name: web-design-guidelines
description: Review UI code for Web Interface Guidelines compliance. Use when asked to "review my UI", "check accessibility", "audit design", "review UX", or "check my site against best practices".
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with the Web Interface Guidelines.

## How It Works

1. Read [RULES.md](RULES.md), the file beside this one: it carries the whole rule set and the output format
2. Read the files named in the request (or ask which files to review)
3. Check them against every rule in RULES.md
4. Output the findings in the terse `file:line` format RULES.md's output format section shows

## The Rules

[RULES.md](RULES.md) is vendored from `vercel-labs/web-interface-guidelines` and ships with this skill, so a review reads the same rules every time and needs no network. It is grouped by category — accessibility, focus states, forms, animation, typography, content handling, images, performance, navigation and state, touch and interaction, safe areas and layout, dark mode and theming, locale and i18n, hydration safety, hover and interactive states, content and copy — and ends with the anti-patterns to flag and the exact output shape.

Read it whole before reviewing. A rule that isn't in that file isn't one of these guidelines, and a finding quoting no rule there is your taste rather than compliance.

## Usage

When a user provides a file or pattern argument:

1. Read RULES.md
2. Read every file the argument names
3. Apply all of RULES.md's rules to each
4. Output one `file:line` line per finding, grouped under the file's path, stating the issue and only the fix where it isn't obvious — no preamble, and a file with nothing to say gets its pass line

If no files are specified, ask the user which files to review.
