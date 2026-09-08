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
  };

  # Dedicated search backend, independent of the conversation model (DeepSeek
  # and GLM do not support this extension's native-search API). Uses pi's Codex
  # login; no credentials belong in this file or the Nix store. Search consumes
  # Codex account usage. Change provider/model here to choose another backend.
  home.file.".pi/agent/web-search.json".text = builtins.toJSON {
    provider = "openai-codex";
    model = "gpt-6-astra";
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
    defaultModel = "~deepseek/deepseek-v4-flash-latest";
    defaultThinkingLevel = "xhigh";
    theme = "dark";
    # Local pi package: its manifest loads src/index.ts directly from the store.
    packages = [ "${webSearch}" ];
    enabledModels = [
      # deepseek flash latest
      "openrouter/~deepseek/deepseek-v4-flash-latest"
      # fable 5.1
      "openrouter/anthropic/claude-fable-5.1"
      # codex / gpt-6-astra
      "openai-codex/gpt-6-astra"
      # glm 5.3
      "openrouter/z-ai/glm-5.3"
    ];
    hideThinkingBlock = false;
  };
}
