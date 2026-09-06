# pi coding agent configuration
# https://github.com/earendil-works/pi-mono
{ pkgs, ... }:
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
