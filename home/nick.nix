{ pkgs, ... }:
{
  imports = [
    ./pi.nix
    ../modules/pi/reviewer.nix
    ../modules/freecad
  ];

  home.stateVersion = "26.05";

  programs.freecadMcp.enable = true;

  home.packages = with pkgs; [
    # User applications
    kdePackages.kate
    signal-desktop
    parsec-bin
  ];

  systemd.user.sessionVariables.EDITOR = "nvim";

  services.ssh-agent.enable = true;
}
