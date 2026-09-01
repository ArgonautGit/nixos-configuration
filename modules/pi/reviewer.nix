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
    # Static deny layer removed per user decision (2026-08-31): the reviewer LLM
    # is the sole gate for non-allowlisted calls. Set rules here to reintroduce a
    # deterministic floor, e.g. { tool = "bash"; pattern = "--no-preserve-root"; }.
    alwaysDeny = [];
    # (denyTerminate is moot while alwaysDeny is empty; kept for schema stability)
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

  # The extension must be ONE directory in the store: the .ts files import each
  # other via relative paths ("./context.ts"), and home-manager file-by-file
  # sources would scatter them across separate store paths and break resolution.
  # Also keeps config.json / rules.md co-located for the loader's fallback path.
  reviewerExtension = pkgs.runCommand "pi-reviewer-extension" { } ''
    mkdir -p $out/lib
    cp ${./reviewer}/index.ts $out/index.ts
    cp ${./reviewer}/lib/*.ts $out/lib/
    cp ${configJson} $out/config.json
    cp ${rulesMd} $out/rules.md
  '';
in
  lib.mkIf cfg.enable {
    home.file.".pi/agent/extensions/reviewer".source = reviewerExtension;
  }
