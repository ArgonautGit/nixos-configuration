{ pkgs, ... }:
{
  imports = [
    ./pi.nix
    ./plasma.nix
    ../modules/pi/instructions.nix
    ../modules/pi/reviewer.nix
    ../modules/freecad
  ];

  home.stateVersion = "26.05";

  # Generate shell startup files so integrations such as Yazi's `y` work.
  programs.bash.enable = true;
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
