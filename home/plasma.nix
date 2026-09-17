# Declarative KDE Plasma configuration via plasma-manager.
# https://nix-community.github.io/plasma-manager/options.html
#
# Portable by design: this file holds KDE settings only — no host- or
# user-specific paths — so it can move to any machine's home-manager config.
#
# Agent workflow: rc2nix converts your current ~/.config into a starting
#   nix run github:nix-community/plasma-manager/trunk
# then prune and move settings into the higher-level modules below.
{ ... }:
{
  programs.plasma = {
    enable = true;

    # By default (false) every option not set here keeps its current value,
    # so enabling the module is non-destructive. Set to true for a fully
    # declarative setup: unlisted keys reset to KDE defaults on login, and
    # activation deletes the KDE config files it manages — back up ~/.config
    # before enabling.
    # overrideConfig = true;

    # -- High-level modules (comment/uncomment as you go) -------------------

    workspace = {
      # Global theme / icons / cursor — `plasma-apply-lookandfeel --list`
      # and `plasma-apply-colorscheme --list` for valid values.
      # lookAndFeel = "org.kde.breezedark.desktop";
      # colorScheme = "BreezeDark";
      # iconTheme = "breeze-dark";
      # cursor = { theme = "Breeze_Snow"; size = 24; };
      # wallpaper = ./wallpapers/foo.jpg;
    };

    # -- Low-level: set individual keys in any KDE rc file (~/.config/...) --
    # configFile."kdeglobals"."KDE"."SingleClick" = true;
    # configFile."kwinrc"."Effect-windowview"."BorderActivate" = 9;
  };
}