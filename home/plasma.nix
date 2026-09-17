# Declarative KDE Plasma configuration via plasma-manager.
# https://nix-community.github.io/plasma-manager/options.html
#
# Portable by design: this file holds KDE settings only — no host- or
# user-specific paths — so it can move to any machine's home-manager config.
#
# Agent workflow: rc2nix converts your current ~/.config into a starting
#   nix run github:nix-community/plasma-manager/trunk
# then prune and move settings into the higher-level modules below.
#
# -- Live reload while iterating ---------------------------------------------
# A rebuild writes these ~/.config/*rc files but never tells the *running*
# session to re-read them. To see a change without logging out, reload the
# part you touched:
#
#   KWin effects  (e.g. the [Effect-overview] screen-edge keys below):
#     qdbus org.kde.KWin /Effects org.kde.kwin.Effects.reconfigureEffect overview
#     # or every loaded effect at once:
#     for e in $(qdbus org.kde.KWin /Effects org.kde.kwin.Effects.loadedEffects); do
#       qdbus org.kde.KWin /Effects org.kde.kwin.Effects.reconfigureEffect "$e"
#     done
#
#   KWin general options  (kwinrc keys outside effects):
#     qdbus org.kde.KWin /KWin reconfigure
#
#   Plasma shell  (panels/widgets, plasmashellrc, ...):
#     systemctl --user restart plasma-plasmashell
#
#   KDE apps  (kate / konsole / okular): just relaunch the app.
#
# Gotcha: `qdbus org.kde.KWin /KWin reconfigure` does NOT reload effects
# (KWin 6.6.6's Workspace::slotReconfigure() never calls effects->reconfigure()),
# so a changed screen edge or effect setting needs the /Effects call above.
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

    # -- Global shortcuts (kglobalshortcutsrc) ------------------------------
    # Meta+Tab should behave like Windows' Task View: KWin's Overview effect
    # shows all windows plus the virtual-desktop strip. By default Meta+Tab is
    # bound to the same switcher as Alt+Tab, so free it there (Alt+Tab keeps
    # cycling windows). Meta+W stays the stock Overview shortcut; drop
    # "Meta+W" from the list to make Meta+Tab the only trigger.
    shortcuts.kwin = {
      "Overview" = [ "Meta+Tab" ];
      "Walk Through Windows" = "Alt+Tab";
    };

    # -- Low-level: set individual keys in any KDE rc file (~/.config/...) --
    # configFile."kdeglobals"."KDE"."SingleClick" = true;

    # Stop the top-left screen corner from opening the Overview (the virtual
    # desktops / activities screen). BorderActivate is an IntList of
    # ElectricBorder values: 7 = ElectricTopLeft (the default), 9 = ElectricNone
    # (no border). GridBorderActivate is the desktop-grid view of the same
    # corner; the old [Effect-DesktopGrid] group no longer exists in Plasma 6.
    configFile."kwinrc"."Effect-overview".BorderActivate = 9;
    configFile."kwinrc"."Effect-overview".GridBorderActivate = 9;

    # Alt+Tab window switcher: [TabBox] DelayTime is the number of
    # milliseconds KWin waits before it shows the switcher popup. KWin
    # hardcodes a default of 90 (src/tabbox/tabbox.cpp); 0 shows it
    # immediately. This changes only *when* the popup appears, not its
    # animation duration, so no other animation is affected.
    configFile."kwinrc"."TabBox".DelayTime = 0;
  };
}
