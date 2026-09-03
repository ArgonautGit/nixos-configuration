{ pkgs, ... }:
{
  imports = [
    ./pi.nix
    ../modules/pi/reviewer.nix
  ];

  home.stateVersion = "26.05";

  home.packages = with pkgs; [
    # User applications
    kdePackages.kate
    signal-desktop
    parsec-bin
  ];

  systemd.user.sessionVariables.EDITOR = "nvim";

  services.ssh-agent.enable = true;
}
