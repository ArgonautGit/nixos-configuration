# rebuild: a nixos-rebuild wrapper that snapshots /etc/nixos to git before
# and after every durable rebuild, so every commit corresponds to a
# generation that survives reboot.
#
# `test`, `dry-activate`, and `build` are transient (no boot entry), so they
# build/activate but never commit — committing them would leave journal
# entries describing generations that vanish on the next reboot.
#
# usage: rebuild [switch|test|boot|dry-activate] [-m "note"]
#
# Portable: enable it on any machine with
#   programs.rebuild.enable = true;
# and configure the flake location if it differs from the defaults.
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.rebuild;

  rebuildScript = pkgs.writeShellScriptBin "rebuild" ''
    #!/usr/bin/env bash
    set -euo pipefail
    cd ${lib.escapeShellArg cfg.flakePath}

    note=""
    while getopts "m:" opt; do
      case $opt in
        m) note="$OPTARG" ;;
        *) echo "usage: rebuild [action] [-m \"note\"]" >&2; exit 2 ;;
      esac
    done
    shift $((OPTIND-1))
    action="''${1:-switch}"

    # Only actions with a durable effect get journal commits.
    case "$action" in
      switch|boot) durable=yes ;;
      *)
        durable=""
        echo "rebuild: '$action' is transient — skipping git snapshot (use switch/boot to record in git)" >&2
        ;;
    esac

    # 1. Snapshot config BEFORE rebuilding, so every commit corresponds
    #    to the generation that's about to be built.
    if [ -n "$durable" ]; then
      git add -A
      if ! git diff --cached --quiet; then
        git commit -m "config: before rebuild $(date '+%F %H:%M')"''${note:+ -m "$note"}
      fi
    fi

    # 2. Rebuild (default: switch).
    sudo nixos-rebuild "$action" --flake ${lib.escapeShellArg cfg.flakePath}#${lib.escapeShellArg cfg.flakeName}

    # 3. Capture anything the rebuild changed afterwards (flake.lock after
    #    --upgrade, stray files), referencing the new generation.
    if [ -n "$durable" ]; then
      git add -A
      if ! git diff --quiet HEAD; then
        git commit -m "rebuild $(date '+%F %H:%M') -> $(readlink result | sed 's|.*/||')"''${note:+ -m "$note"}
      fi
    fi
  '';
in
{
  options.programs.rebuild = {
    enable = lib.mkEnableOption "the rebuild wrapper (git-snapshotting nixos-rebuild)";

    flakePath = lib.mkOption {
      type = lib.types.str;
      default = "/etc/nixos";
      description = "Path to the flake containing this machine's configuration.";
    };

    flakeName = lib.mkOption {
      type = lib.types.str;
      default = config.networking.hostName;
      defaultText = lib.literalExpression "config.networking.hostName";
      description = ''
        Attribute name in `nixosConfigurations` to build. Defaults to the
        machine's hostname, which matches the flake convention
        (`nixosConfigurations.<hostname>`).
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    environment.systemPackages = [ rebuildScript ];
  };
}
