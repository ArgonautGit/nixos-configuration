# ChatGPT Community with Linux computer use for KDE Plasma 6 on NixOS.
#
# Save beside configuration.nix and add this path to its existing imports:
#   imports = [ ./chatgpt-desktop.nix ];
# Remove any previous ChatGPT Community package entry to avoid duplicates.
# Requires the Nix flakes experimental feature to be enabled when evaluating.
# No additional flake input or specialArgs is required.
#
# Rebuild, log out/in, then ask the app:
#   Check whether Linux Computer Use is ready.
# Accept KDE's screen-sharing/remote-control prompt when requested.
#
# Updates: replace upstream_rev with a reviewed full upstream commit hash,
# then rebuild. Updating your system flake.lock alone does not update this pin.
# Sources:
# https://github.com/ilysenko/codex-desktop-linux/blob/main/docs/nix.md
# https://github.com/ilysenko/codex-desktop-linux/blob/main/docs/linux-computer-use.md
# https://github.com/NixOS/nixpkgs/blob/master/nixos/modules/programs/ydotool.nix

{
  config,
  lib,
  pkgs,
  ...
}:

let
  # Verified upstream revision from September 4, 2026.
  upstream_rev = "70662cbe6f59c2b42b17e86a80a00c3a0760a75c";
  upstream = builtins.getFlake "github:ilysenko/codex-desktop-linux/${upstream_rev}";

  # Leave empty to use KDE's portal input support first.
  # If the readiness check needs ydotool, set this to your Linux username(s):
  #   ydotool_users = [ "nick" ];
  # These users gain permission to inject keyboard and mouse input.
  ydotool_users = [ ];
in
{
  environment.systemPackages = [
    upstream.packages.${pkgs.stdenv.hostPlatform.system}.codex-desktop-computer-use-ui
  ];

  # KDE portal and PipeWire provide the screen-sharing infrastructure.
  xdg.portal = {
    enable = true;
    extraPortals = [ pkgs.kdePackages.xdg-desktop-portal-kde ];
  };
  services.pipewire.enable = lib.mkDefault true;

  # Disable the community launcher's anonymous daily usage report.
  environment.sessionVariables.CODEX_LINUX_DISABLE_USAGE_REPORTING = "1";

  # Optional input fallback. NixOS supplies the daemon and YDOTOOL_SOCKET.
  programs.ydotool.enable = lib.mkIf (ydotool_users != [ ]) true;
  users.users = lib.genAttrs ydotool_users (_: {
    extraGroups = [ config.programs.ydotool.group ];
  });
}
