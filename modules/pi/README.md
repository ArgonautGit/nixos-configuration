# pi reviewer extension

A model-backed permission gate for pi coding-agent tool calls. A separate
reviewer evaluates each call against the conversation and permission rules.
The default is **Jev 1.13 via OpenRouter Decisions**, not chat completions.
Fail-closed by default; chat reviewers remain selectable.

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
  ├─ 2. REVIEWER           conversation context + proposed call + rules.md
  │                        → Jev typed choice + confidence + probabilities
  │                        → uncertain / low-confidence allow = deny
  │                        → malformed/failed/timed out = deny (fail-closed)
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
| ask   | reviewer denials block; after reviewer approval the user must explicitly Allow. Without a UI → blocks. |
| allow | unconstrained; extension is inert. |

Commands:
- `/perm` — interactive mode picker
- `/perm deny|ask|allow|status`
- `/reviewer-model` — Jev models plus the scoped chat models (or full chat catalogue)
- `/reviewer-explain [last|deny|entry-id] [context]` — inspect a recorded result without a model call

A status widget above the editor always shows `reviewer: <mode> · model: <model>`.

## Configuration

All behavior lives in `modules/pi/reviewer.nix`. Edit + rebuild; never edit the
generated files under `~/.pi` (they are store symlinks).

Options:
- `defaultMode` — deny | ask | allow (deny recommended)
- `reviewerModel` — "provider/id"; "" forces interactive selection on first
  guarded tool call of a session (mirrors the /model picker)
- `reviewerThinking` — chat reviewer thinking level; ignored for Jev
- `jevMinConfidence` — minimum native Jev confidence to accept `allow` (default 0.9);
  not the same as `P(allow)`. Missing/invalid confidence or probabilities fail closed.
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
2. Add any new source files to Git before rebuilding: `git add modules/pi/reviewer/`.
   Git-backed flakes omit untracked files even when tracked files import them.
   Staging is enough; no commit is required.
3. Activate: `sudo nixos-rebuild switch --flake /etc/nixos#nixos` (or `test`).
4. Already-open pi sessions: `/reload` picks up the new store copy. If you
   started with `pi -ne`, exit and restart plain `pi` to enable discovery.

A missing `./models.ts` or `./jev.ts` error means an incomplete extension was
packaged. Stage the new files and rebuild; do not edit the `/nix/store` copy.
The build checks required library files so this now fails before activation.

## Failure policy

Fail-closed everywhere: reviewer error/timeout/unparseable reply ⇒ deny with an
explanatory reason (source: `fail-closed`). No reviewer model configured and no
UI to pick one ⇒ block, telling the agent to have the user run /reviewer-model.
Fail-closed verdicts are deliberately NOT cached — a retry gets a fresh review.

## Jev integration

- Model: `openrouter/typesafe/jev-1.13` (pinned); the picker also offers
  `openrouter/~typesafe/jev-latest`. Neither is added to pi's main chat catalogue.
- Endpoint: `POST https://openrouter.ai/api/alpha/decisions` with `state` and
  `questions.permission` (`choice`: `allow`, `deny`, `uncertain`). No chat
  `messages`, `response_format`, generated rationale, or fallback model call.
- Auth is resolved through `ctx.modelRegistry.getProviderAuth("openrouter")`.
  Uses the existing pi OpenRouter login/key and headers; no new secret files.
  Configured base URLs ending in `/api/v1` map to `/api/alpha/decisions`, retaining
  proxy prefixes. Redirects are rejected. Provider-side account routing settings apply.
- Numeric confidence and the probability distribution are validated. `uncertain`
  always blocks; `allow` below the configured confidence threshold also blocks.
  Displayed reasons report the classification and scores, **not invented reasoning**.
  `/reviewer-explain ... context` shows questions under SYSTEM and state under USER.
- Jev has a 32K-token context. Requests have a conservative 28,000 serialized UTF-8
  byte cap, including questions; oversize requests block before any network call.
  Nix sets the transcript budget to 16,000 characters. Complete tool arguments
  are never clipped to make a request fit; split large calls instead.
- No decision cache. Auth resolution, HTTP requests, response parsing and retry
  delays share the review timeout and caller cancellation.
- Transient DNS/socket failures and HTTP 408/429/500/502/503/504/524/529 retry up
  to three total attempts with 250ms/500ms backoff. A longer `Retry-After` is
  respected up to 5s; beyond that the call fails closed rather than retrying early.
  Retries can incur additional inference charges, but never execute the proposed tool.
- Authentication/payment/request errors, certificate errors, malformed JSON,
  invalid verdicts, and actual denial/uncertain/low-confidence results are not
  retried. No schema-free retry or fallback model for Jev.
- Transport errors include safe DNS/socket/TLS codes and attempt counts. Raw
  exception messages, HTTP error bodies, headers and credentials are not echoed.

**Limitations:** the API is alpha. TypeSafe documents sensitivity to irrelevant
context, literal interpretation, and adversarial instructions in input. This is
an advisory model gate, not a sandbox or a security boundary. The existing read
allowlist and permission modes are unchanged. Evaluate your workloads before
relying on automatic approval; confidence is not a safety guarantee.

References:
- [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
- [Jev model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Chat reviewer output robustness

The following applies only when selecting a chat reviewer instead of Jev.
Layered, strongest first:
1. **Structured outputs** — reviewer calls carry a marker in the system prompt;
   `before_provider_request` attaches `response_format: json_schema` to those
   payloads only (never the main agent's). Providers with constrained sampling
   hard-enforce the verdict schema. If a provider rejects it, the call is
   retried once without it.
2. **Tolerant parsing** — balanced-brace JSON candidates; invalid-escape
   sanitization (models quoting regex text like `\\s+` inside `reason` used to
   break strict JSON); markdown fences; case-insensitive decision; loose
   field scan. No keyword fallback: incidental prose is not permission.
3. **Raw logging** — every reviewer decision entry stores the raw reply
   (truncated), so a "not a valid verdict" is diagnosable in the transcript
   (visible when expanding the entry) instead of a mystery.

## Tests

Use Node >= 24 and set `PI_PACKAGE_DIR` to the installed pi package root (the
folder containing `dist/` and `package.json`, not the executable):

```sh
node --test modules/pi/reviewer/tests/reviewer.test.mjs
```

All responses in that suite are mocked; it does not use credentials or execute
proposed tools. Build just the extension without activating NixOS (the `path:`
flake includes new, not-yet-tracked files):

```sh
out=$(nix build 'path:/etc/nixos#nixosConfigurations.nixos.config.home-manager.users.nick.home.file.".pi/agent/extensions/reviewer".source' --no-link --print-out-paths)
node modules/pi/reviewer/tests/jev-live.mjs --live "$out"
```

The explicitly opt-in live test loads code from the Nix-built extension (not
from the checkout), and uses existing pi OpenRouter auth and credits.
It sends only synthetic fixtures plus the built rules, not the current session;
no proposed tools are executed. Nonzero exit means a behavior mismatch or API
failure. A successful transport test does not establish classifier safety.

Initial live check (2026-09-18): all 10 calls returned valid classifications;
8/10 final decisions matched the fixtures. All five expected denials blocked.
Two legitimate actions (reviewer maintenance and an already-consumed one-call
prohibition) classified as `allow` but were conservatively blocked at confidence
0.87 and 0.86, below 0.9. The threshold was **not lowered to fit these examples**.

Transport follow-up: 11/11 live requests returned valid classifications without
connection errors, with 9/11 final decisions matching expectations (the same two
confidence-based false denials). An additional harmless `printf` fixture with an
explicit user prohibition was correctly denied at 0.99 confidence. The original
intermittent `fetch failed` cause could not be reproduced; mocked tests cover
transient recovery, exhausted retries, permanent errors, and cancellation.

## Notes

- pi auto-discovers ANY `extensions/*/index.ts` — renaming a dir (e.g. `.bak`)
  does not disable it; remove the path instead. Disable everything with `pi -ne`.
- `PI_REVIEWER_CONFIG_DIR` env var overrides the config/rules location (dev/testing).
- Extension code lives in this repo at `modules/pi/reviewer/`; the nix module
  builds it into one store directory (files must stay co-located: the lib
  modules use relative imports).
