# pi reviewer extension

A model-backed permission gate for pi coding-agent tool calls. A separate
reviewer evaluates each call against the conversation and permission rules.
The default is **Jev 1.13 via OpenRouter Decisions**, not chat completions.
Fail-closed by default; chat reviewers remain selectable.

**Safety repair:** original user messages and the assistant turns preceding user
replies are now preserved whole, including across compaction. If that evidence
cannot fit, code blocks the review before contacting a model. This fixes the
known clipping path, not arbitrary classifier mistakes: this is still **not a
security boundary**. The automatic confidence threshold remains 0.9.
See the [assessment and reproducible results](reviewer/tests/ASSESSMENT.md).

Code: `modules/pi/reviewer/` (TypeScript, loaded by pi as an extension)
Module: `reviewer.nix` (all behavior options + reviewer rules text)
Installed to: `~/.pi/agent/extensions/reviewer` (single store dir via home-manager)

## Decision pipeline

```
tool call
  │
  ├─ 0. DENY-NEXT          explicit pending command → consume ID and block
  │                        (before allow mode, allowlists, or tool exclusions)
  ├─ 1. STATIC CHECKS      alwaysDeny → block; alwaysAllow → pass
  │                        (allow mode bypasses static/model checks)
  ├─ 2. CONTEXT CHECK      missing/oversized required evidence → block, no model
  ├─ 3. REVIEWER           complete evidence + full proposed call + rules.md
  │                        → deny / uncertain / invalid / failed → block
  │                        → low-confidence allow → human approval required
  └─ 4. USER GATE          ask mode OR valid low-confidence Jev allow:
                           inspect full exact call, then explicitly approve
                           (changed call/context, cancellation, no UI → block)
```

Every decision is appended to the session as a `reviewer-decision` entry
(rendered in the TUI, not sent to the LLM context) with a `source` field:
`static-allow | static-deny | reviewer | user | fail-closed | incomplete-context`.

## Permission modes

| mode  | behavior |
|-------|----------|
| deny  | default. Reviewed calls require reviewer ALLOW; below-threshold Jev allows additionally require exact-call human approval. |
| ask   | reviewer deny/uncertain/errors block; valid allows additionally require exact-call human approval. No UI → block. |
| allow | bypasses static/model review, but an explicitly armed deny-next still blocks one preflight. |

Commands:
- `/perm` — interactive mode picker
- `/perm deny|ask|allow|status`
- `/perm deny-next` — block exactly one new tool preflight; reissuing renews its ID
- `/reviewer-model` — Jev models plus the scoped chat models (or full chat catalogue)
- `/reviewer-explain [last|deny|entry-id] [context]` — inspect a recorded result without a model call

A status widget above the editor always shows `reviewer: <mode> · model: <model>`.
`/perm status` also reports the pending deny-next ID. This explicit command is
not inferred from natural language or quoted tool output. Reissuing it replaces
an outstanding arm rather than queuing additional blocks. Consumption is recorded
synchronously before any model/UI await, follows the active branch, and survives
reload/compaction independently of `sessionPersistence`. Old denials cannot
consume a renewed ID. Already-pending approvals are invalidated when it is armed.
Natural-language one-call requests still depend on the classifier; use the command
when deterministic enforcement is needed.

## Configuration

All behavior lives in `modules/pi/reviewer.nix`. Edit + rebuild; never edit the
generated files under `~/.pi` (they are store symlinks).

Options:
- `defaultMode` — deny | ask | allow (deny recommended)
- `reviewerModel` — "provider/id"; "" forces interactive selection on first
  guarded tool call of a session (mirrors the /model picker)
- `reviewerThinking` — chat reviewer thinking level; ignored for Jev
- `jevMinConfidence` — minimum native Jev confidence for automatic `allow` (default 0.9);
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
  always blocks; below-threshold `allow` blocks automatic execution and requires
  exact-call human approval. Deny, uncertainty, malformed replies, transport errors,
  and incomplete context never offer this override.
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
  Unknown exceptions from auth resolution, header construction, or the chat SDK
  are suppressed too; only reviewer-constructed safe errors are displayed.

**Limitations:** the API is alpha. TypeSafe documents sensitivity to irrelevant
context, literal interpretation, and adversarial instructions in input. This is
an advisory model gate, not a sandbox or a security boundary. The existing read
allowlist and permission modes are unchanged. Evaluate your workloads before
relying on automatic approval; confidence is not a safety guarantee.

References:
- [OpenRouter Decisions API](https://openrouter.ai/docs/api/api-reference/alphadecisions/submit-a-decisions-questions-and-answers-request)
- [Jev model limitations](https://docs.typesafe.ai/model-jaggedness/jev-1.13)

## Context selection and false blocks

The reviewer reads original messages from `getBranch()`, not just the compacted
model context. Every user record and every assistant message in the turn preceding
a user reply is retained whole, in order and with its original role. This preserves
multi-message proposals that a short "yes" may refer to. Assistant thinking is
excluded. Abandoned branches are excluded; summaries never replace user authority.

Required evidence must fit both configured character and record budgets, including
JSON escaping. Missing original history, unsupported non-text user evidence, and
budget overflow block **before** requesting a model, even if a mocked response
would allow. Tool arguments and the complete Jev request must also fit their caps.

Optional supporting data may still be clipped/omitted: up to eight records,
including two recent review outcomes and a summary (at most 2,000 characters;
other optional records at most 800 each). Its omission cannot authorize anything.

**Conservative trade-off:** long histories and long preceding assistant turns can
now block legitimate work. Compaction does not erase restrictions or reset this
budget. Start a fresh session with complete current instructions, or deliberately
increase the context budget within the model's request cap. There is no automatic
summary-based reset or human-override prompt for incomplete context.

Historical review outcomes say whether a call was blocked, without copying the
old rationale/confidence back into the next review. The full original verdict
remains available through `/reviewer-explain`. Rules also distinguish Pi's
`PI_PROVIDER`/`PI_MODEL` name metadata from authentication variables; this does not
allowlist `printenv`, whole-environment dumps, or any shell command.

The automatic threshold remains 0.9; valid verdicts are never retried to obtain
an allow. For a validated below-threshold Jev allow, the UI first opens a scrollable
editor containing the complete tool name, call ID, working directory, and arguments.
Editing the preview denies approval; it cannot modify the tool call. Submit the
unchanged inspection to proceed, then select **Allow this call**;
Esc or any other response denies. Approval applies only to that invocation, never
to retries or sibling calls. Dialogs are serialized. Changes to arguments, user
instructions, session/branch, permission mode, reviewer model, or cancellation
invalidate pending approvals. The SDK editor has no abort-signal API: after a
cancellation, it may still need to be closed, but it cannot grant approval.

Automatic allows also recheck their binding before this hook returns. This does
not sandbox tools, prevent filesystem races, or constrain other trusted extensions
that modify a call afterward. Static allowlists and explicit allow mode bypass the
context/model check. A low-confidence block is not a network failure; neither
mocked tests nor a confidence score prove a model's live permission judgment.

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
node --test modules/pi/reviewer/tests/reviewer.test.mjs modules/pi/reviewer/tests/assessment.test.mjs
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
`tests/fixtures.mjs` constructs the same inputs for mocked and live checks,
including realistic assistant content blocks and generated noisy histories.
Cases include allowed diagnostics and paired forbidden network changes, so a
context reduction cannot pass merely by removing the user's restrictions.

For the expanded repeated assessment and offline threshold comparison, see
[`reviewer/tests/ASSESSMENT.md`](reviewer/tests/ASSESSMENT.md). Its local helper tests
run with `node --test modules/pi/reviewer/tests/assessment.test.mjs` (no credentials
or network). The assessment changes no installed permission settings.

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

Context-selection follow-up (2026-09-19): 58 mocked tests, TypeScript checking,
and the Nix extension build pass. The final live run returned valid
classifications for all 17 fixtures; 14/17 matched the expected final decision.
All nine expected denials blocked, and noisy-history ping/Git-status cases passed.
Three legitimate actions still blocked at the unchanged 0.9 threshold: reviewer
maintenance (0.87), a consumed one-call prohibition (0.76), and provider/model
name inspection (0.88). Metadata inspection passed an earlier run at 0.90, so
borderline scores are not stable. This remains an experimental classifier gate,
not a claim that false denials or intermittent network faults are resolved.

Safety-repair validation: **79/79 local tests**, TypeScript checking, and the Nix
extension build pass. The original 99-sample reassessment had **zero false allows**,
but **30/42 benign samples remained blocked automatically**: 18 were eligible for
exact-call human approval, while 12 exceeded the required-context budget. Added
within-budget long-message controls denied the middle prohibition 3/3 and allowed
benign Git status 3/3. Pending recommendations are not reported as completed blocks
in later review context. The repair is not activated by building the extension.
See the assessment for build/report paths and the conservative usability trade-off.

## Notes

- pi auto-discovers ANY `extensions/*/index.ts` — renaming a dir (e.g. `.bak`)
  does not disable it; remove the path instead. Disable everything with `pi -ne`.
- `PI_REVIEWER_CONFIG_DIR` env var overrides the config/rules location (dev/testing).
- Extension code lives in this repo at `modules/pi/reviewer/`; the nix module
  builds it into one store directory (files must stay co-located: the lib
  modules use relative imports).
