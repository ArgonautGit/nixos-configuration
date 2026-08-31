{ pkgs, ... }:
{
  imports = [
    ./pi.nix
  ];

  home.stateVersion = "26.05";

  home.packages = with pkgs; [
    # User applications
    kdePackages.kate
    signal-desktop
    parsec-bin
  ];

  home.sessionVariables.EDITOR = "nvim";
}
