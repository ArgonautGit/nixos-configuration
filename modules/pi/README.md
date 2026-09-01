# pi reviewer extension

An LLM permission gate for pi coding-agent tool calls. A separate "reviewer"
model evaluates each tool call in the context of the conversation and decides
whether it serves the user's intent. Fail-closed by default.

Code: `modules/pi/reviewer/` (TypeScript, loaded by pi as an extension)
Module: `reviewer.nix` (all behavior options + reviewer rules text)
Installed to: `~/.pi/agent/extensions/reviewer` (single store dir via home-manager)

## Decision pipeline

```
tool call
  │
  ├─ 1. STATIC CHECKS      alwaysDeny  → block (no LLM, no prompt)
  │      (pure regex)      alwaysAllow → pass, no reviewer cost
  │
  ├─ 2. REVIEWER LLM       conversation context + proposed call + rules.md
  │                        → { decision, confidence, reason } JSON verdict
  │                        → unparseable/failed/timed out = deny (fail-closed)
  │
  └─ 3. USER GATE          ask mode only: verdict shown, user must Allow/Deny
```

Every decision is appended to the session as a `reviewer-decision` entry
(rendered in the TUI, not sent to the LLM context) with a `source` field:
`static-allow | static-deny | reviewer | user | fail-closed`.

## Permission modes

| mode  | behavior |
|-------|----------|
| deny  | default for every new session. Reviewed calls pass only on an explicit reviewer ALLOW (plus static alwaysAllow). Fail-closed. |
| ask   | reviewer always advises; user must explicitly Allow, even on an ALLOW verdict. Without a UI → behaves as deny. |
| allow | unconstrained; extension is inert. |

Commands:
- `/perm` — interactive mode picker
- `/perm deny|ask|allow|status`
- `/reviewer-model` — pick the reviewer model (same style as /model; scoped models first)

A status widget above the editor always shows `reviewer: <mode> · model: <model>`.

## Configuration

All behavior lives in `modules/pi/reviewer.nix`. Edit + rebuild; never edit the
generated files under `~/.pi` (they are store symlinks).

Options:
- `defaultMode` — deny | ask | allow (deny recommended)
- `reviewerModel` — "provider/id"; "" forces interactive selection on first
  guarded tool call of a session (mirrors the /model picker)
- `reviewerThinking` — reviewer thinking level ("off" for cheap fast models)
- `reviewTimeoutMs` — reviewer call timeout; timeout/abort/unparseable = deny
- `reviewedTools` — subset to review; empty list = all tools
- `alwaysAllow` / `alwaysDeny` — static regex rules checked BEFORE the reviewer
  (`{ tool = "bash"; pattern = "regex"; }`; pattern omitted = match all inputs
  of that tool). alwaysDeny fires even in ask mode with no user prompt.
- `denyTerminate` — alwaysDeny matches that should also stop the agent
- `sessionPersistence` — restore mode + model on /resume (stored in session)
- `contextBudget` — transcript budget for the reviewer (maxMessages/maxChars)
- `rules` — verbatim reviewer rules text (injected into the reviewer's system prompt)

## Changing behavior

1. Edit `/etc/nixos/modules/pi/reviewer.nix` (rules text, allowlists, model…).
2. `rebuild switch` (or `test` — extension dir updates either way; the wrapper
   only commits git for switch/boot).
3. Already-open pi sessions: `/reload` picks up the new store copy.

## Failure policy

Fail-closed everywhere: reviewer error/timeout/unparseable reply ⇒ deny with an
explanatory reason (source: `fail-closed`). No reviewer model configured and no
UI to pick one ⇒ block, telling the agent to have the user run /reviewer-model.
Fail-closed verdicts are deliberately NOT cached — a retry gets a fresh review.

## Output robustness (how verdicts are made parseable)

Layered, strongest first:
1. **Structured outputs** — reviewer calls carry a marker in the system prompt;
   `before_provider_request` attaches `response_format: json_schema` to those
   payloads only (never the main agent's). Providers with constrained sampling
   hard-enforce the verdict schema. If a provider rejects it, the call is
   retried once without it.
2. **Tolerant parsing** — balanced-brace JSON candidates; invalid-escape
   sanitization (models quoting regex text like `\\s+` inside `reason` used to
   break strict JSON); markdown fences; case-insensitive decision; loose
   field scan; keyword fallback (confidence: low).
3. **Raw logging** — every reviewer decision entry stores the raw reply
   (truncated), so a "not a valid verdict" is diagnosable in the transcript
   (visible when expanding the entry) instead of a mystery.

## Notes

- pi auto-discovers ANY `extensions/*/index.ts` — renaming a dir (e.g. `.bak`)
  does not disable it; remove the path instead. Disable everything with `pi -ne`.
- `PI_REVIEWER_CONFIG_DIR` env var overrides the config/rules location (dev/testing).
- Extension code lives in this repo at `modules/pi/reviewer/`; the nix module
  builds it into one store directory (files must stay co-located: the lib
  modules use relative imports).
