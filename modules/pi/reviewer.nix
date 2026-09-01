# pi "reviewer" extension — LLM permission gate for tool calls.
#
# Self-contained module: generates the extension code link, config.json,
# and rules.md from the options below. Import from home/nick.nix:
#
#   imports = [ ./modules/pi/reviewer.nix ];
#
# and enable it:
#   programs.pi.reviewer.enable = true;
#
# NOTE (read-only planning): this draft lives in /tmp/reviewer-dev/reviewer.nix.
# Copy to /etc/nixos/modules/pi/reviewer.nix only when you explicitly decide to.
{
  pkgs,
  lib,
  ...
}: let
  cfg = {
    enable = true;

    # Reviewer model as "provider/id". Leave "" to force interactive selection
    # (the /model-style picker) on first guarded tool call each session.
    reviewerModel = "openrouter/z-ai/glm-5.3-flash";
    reviewerThinking = "off";
    reviewTimeoutMs = 30000;

    # Session start mode: "deny" (default, fail-closed), "ask", "allow".
    defaultMode = "deny";
    sessionPersistence = false;

    # Empty list = review every tool call.
    reviewedTools = [];

    # Static fast paths (checked before the reviewer runs; regex on rendered JSON input).
    alwaysAllow = [
      { tool = "read"; }
      {
        tool = "bash";
        pattern = "^(ls|cat|head|tail|rg|grep|find|git (status|diff|log|show))\\b";
      }
    ];
    alwaysDeny = [
      {
        tool = "bash";
        pattern = "\\brm\\s+-rf\\s+(/|~)\\b";
      }
    ];
    # alwaysDeny matches that should ALSO stop the agent entirely:
    denyTerminate = [];

    contextBudget = {
      maxMessages = 40;
      maxChars = 60000;
    };

    # Reviewer rules: verbatim text injected into the reviewer's system prompt.
    rules = ''
      # Reviewer Rules

      ## Philosophy
      - Presume least privilege. Read-only actions (listing files, reading source,
        search, git status/diff/log) are fine.
      - Actions that modify files, install things, mutate system or repository state,
        or contact external services must clearly serve the user's most recent request.

      ## Environment facts
      - The user runs NixOS. /nix/store is read-only; system configuration lives in
        /etc/nixos (flake-based).
      - `nixos-rebuild switch`, profile installs, or edits under /etc/nixos change the
        user's system — deny those unless the user explicitly requested them in this
        conversation.
      - Never approve deleting user data, force-pushing, credential handling, or
        publishing anything.

      ## Behavior
      - If the call plainly serves the stated intent and is proportionate, allow.
      - If intent is unclear or the call exceeds it, deny with a reason the agent can
        act on (state the mismatch and suggest the narrower alternative).
      - If you are unsure, deny with low confidence — the user gate will decide in ask mode.
    '';
  };

  mkRule = r:
    if r.pattern or null == null
    then { inherit (r) tool; }
    else {
      inherit (r) tool;
      pattern = r.pattern;
    };

  configJson = pkgs.writeText "reviewer-config.json" (builtins.toJSON {
    inherit (cfg) defaultMode reviewerModel reviewerThinking reviewTimeoutMs reviewedTools sessionPersistence;
    alwaysAllow = map mkRule cfg.alwaysAllow;
    alwaysDeny = map mkRule cfg.alwaysDeny;
    denyTerminate = map mkRule cfg.denyTerminate;
    contextBudget = {
      inherit (cfg.contextBudget) maxMessages maxChars;
    };
  });

  rulesMd = pkgs.writeText "reviewer-rules.md" cfg.rules;
in
  lib.mkIf cfg.enable {
    # Extension code: linked from the immutable store copy (edit the .ts files,
    # re-copy into /etc/nixos, rebuild to deploy).
    home.file.".pi/agent/extensions/reviewer/index.ts".source = ./reviewer/index.ts;
    home.file.".pi/agent/extensions/reviewer/lib/state.ts".source = ./reviewer/lib/state.ts;
    home.file.".pi/agent/extensions/reviewer/lib/config.ts".source = ./reviewer/lib/config.ts;
    home.file.".pi/agent/extensions/reviewer/lib/context.ts".source = ./reviewer/lib/context.ts;
    home.file.".pi/agent/extensions/reviewer/lib/picker.ts".source = ./reviewer/lib/picker.ts;
    home.file.".pi/agent/extensions/reviewer/lib/reviewer.ts".source = ./reviewer/lib/reviewer.ts;
    home.file.".pi/agent/extensions/reviewer/lib/entry.ts".source = ./reviewer/lib/entry.ts;

    # Generated behavior config + reviewer rules (declaratively managed).
    home.file.".pi/agent/extensions/reviewer/config.json".source = configJson;
    home.file.".pi/agent/extensions/reviewer/rules.md".source = rulesMd;
  }
