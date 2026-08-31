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
          by = "throughput";
          partition = "model";
        };
      };
    };
  };
}
