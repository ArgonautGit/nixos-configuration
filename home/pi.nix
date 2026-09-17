# pi coding agent configuration
# https://github.com/earendil-works/pi-mono
{ pkgs, ... }:
let
  # https://github.com/ttttmr/pi-web-search
  # Pin and unpack with Nix: no `pi install` or runtime npm downloads.
  # This release only needs the peer dependencies bundled by pi (>= 0.80.3).
  # To update: review the release, bump version + tarball hash, then rebuild.
  webSearchVersion = "1.4.0";
  webSearchArchive = pkgs.fetchurl {
    url = "https://registry.npmjs.org/pi-web-search/-/pi-web-search-${webSearchVersion}.tgz";
    hash = "sha256-v/fVu275TWIz42njTmquZm+G9tUAozCCYj/GHlV47SM=";
  };
  webSearch = pkgs.runCommand "pi-web-search-${webSearchVersion}" { } ''
    mkdir -p "$out"
    tar -xzf ${webSearchArchive} --strip-components=1 -C "$out"
    test -f "$out/src/index.ts"
    # pi-web-search 1.4.0 hardcodes "none", which GPT-6 Astra rejects (HTTP 400).
    # Use its lowest supported effort; leave other models unchanged. Remove this
    # workaround once an upstream release selects a supported effort for Astra.
    # --replace-fail makes upstream source changes fail visibly during upgrades.
    substituteInPlace "$out/src/api.ts" --replace-fail \
      'requestBody.reasoning = { effort: "none" };' \
      'requestBody.reasoning = { effort: model.id === "gpt-6-astra" ? "low" : "none" };'
  '';
in
{
  home.packages = [ pkgs.pi-coding-agent ];

  home.file.".pi/agent/models.json".text = builtins.toJSON {
    providers.openrouter.modelOverrides."z-ai/glm-5.3-flash" = {
      compat.openRouterRouting = {
        # No hard pin: route to whichever endpoint is currently fastest.
        # "throughput" = most output tokens/sec (best for a coding agent);
        # change to "latency" to optimize time-to-first-token instead.
        sort = {
          # by = "throughput";
          partition = "model";
        };
      };
    };

    # qwen3.8-27b-mtp-80k is served by the local llama.cpp router (see the
    # llama.cpp entry in ~/.pi/agent/models-store.json). pi's built-in
    # llama.cpp extension hard-codes reasoning: false for the whole catalog,
    # so re-enable extended thinking here.
    #
    # Qwen3.8's embedded chat template only accepts chat_template_kwargs
    # (a top-level reasoning_effort is silently ignored by llama.cpp):
    #   enable_thinking: whether to think at all
    #   reasoning_effort: "xhigh" (default) | "medium" | "low" — any other
    #     value makes the template raise (verified against the server: the
    #     GGUF carries the stock Qwen3.8-27B template).
    #
    # This is pi's "chat-template" thinking format: "thinking.enabled"
    # inserts the boolean, "thinking.effort" inserts the value from
    # thinkingLevelMap, mapping pi's 7 normal levels onto the 3 the model
    # supports. modelOverrides is the top-most user-config layer, so it
    # applies on top of the extension's models and merges into their compat
    # (keeps supportsDeveloperRole: false, maxTokensField: "max_tokens", etc.).
    providers."llama.cpp".modelOverrides."qwen3.8-27b-mtp-80k" = {
      reasoning = true;
      # The local instance runs with --ctx-size 81920; pin it so pi doesn't
      # fall back to the training-context default when the catalog report
      # lacks a live n_ctx (e.g. while the instance is unloaded/sleeping).
      contextWindow = 81920;
      maxTokens = 81920;
      compat = {
        thinkingFormat = "chat-template";
        chatTemplateKwargs = {
          "enable_thinking" = {
            "$var" = "thinking.enabled";
          };
          "reasoning_effort" = {
            "$var" = "thinking.effort";
          };
          "preserve_thinking" = true;
        };
      };
      # pi level -> Qwen3.8 reasoning_effort ("low" | "medium" | "xhigh"):
      # exactly one pi level per model level. Redundant ones are dropped from
      # the picker via null (minimal folds into low; high and max fold into
      # xhigh). Off is handled by enable_thinking: false + omitted effort.
      thinkingLevelMap = {
        minimal = null;
        low = "low";
        medium = "medium";
        high = null;
        xhigh = "xhigh";
        max = null;
      };
    };
  };

  # Dedicated search backend, independent of the conversation model (DeepSeek
  # and GLM do not support this extension's native-search API). Uses pi's Codex
  # login; no credentials belong in this file or the Nix store. Search consumes
  # Codex account usage. Change provider/model here to choose another backend.
  home.file.".pi/agent/web-search.json".text = builtins.toJSON {
    provider = "openai-codex";
    model = "gpt-6-astra";
  };

  # Fast mode: @pi-plugins/fast-mode sets service_tier = "priority" on the
  # requests for the models listed here. Scoped to Codex Astra only; it uses
  # the openai-codex subscription (not an OpenAI API key). Priority inference
  # burns Codex subscription allowance faster and costs more. Toggle per
  # session with `/fast on` / `/fast off`, or set enabled = false to default off.
  home.file.".pi/agent/extensions/fast-mode.json".text = builtins.toJSON {
    enabled = true;
    showStatus = true;
    models = [
      "openai-codex/gpt-6-astra"
    ];
  };

  # Scoped models: declaratively pin the set of models usable for
  # Ctrl+P cycling and the /scoped-models picker (pi's `enabledModels`
  # setting, matched as `provider/modelId` globs against the model
  # catalogue). This file also carries the startup defaults that pi's
  # /model + Ctrl+S writes; promoted into home-manager so they are
  # reproducible across rebuilds. Values verified against the
  # pi 0.85.1 bundled catalogue.
  home.file.".pi/agent/settings.json".text = builtins.toJSON {
    lastChangelogVersion = "0.85.1";
    defaultProvider = "openrouter";
    defaultModel = "~deepseek/deepseek-flash-latest";
    defaultThinkingLevel = "xhigh";
    theme = "dark";
    packages = [
      # Local package: load src/index.ts directly from the store.
      "${webSearch}"
      # pi installs this pinned release + its npm dependencies on first start.
      # Unlike web-search, this is not an offline/Nix-built dependency closure.
      # FreeCAD's local connection is configured by modules/freecad/default.nix.
      "npm:pi-mcp-adapter@2.32.1"
      # Fast mode: injects service_tier = "priority" into matching requests.
      # Configured below in ~/.pi/agent/extensions/fast-mode.json.
      "npm:@pi-plugins/fast-mode@0.1.12"
    ];
    enabledModels = [
      # latest deepseek flash (v4.1 at time of writing)
      "~deepseek/deepseek-flash-latest"
      # fable 5.1
      "openrouter/anthropic/claude-fable-5.1"
      # codex / gpt-6-astra
      "openai-codex/gpt-6-astra"
      # glm 5.3
      "openrouter/z-ai/glm-5.3"
      # local Qwen 3.8 with MTP drafting (see models.json override for the
      # thinking-level map and the 81,920 ctx pin)
      "llama.cpp/qwen3.8-27b-mtp-80k"
    ];
    hideThinkingBlock = false;
  };
}
