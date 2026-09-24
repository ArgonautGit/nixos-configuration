{ pkgs, inputs, ... }:
let
  # claude-code moves fast (new models land ahead of the stable nixpkgs
  # branch), so track nixpkgs-unstable for this one package instead of
  # waiting for the next stable channel bump.
  pkgs-unstable = import inputs.nixpkgs-unstable {
    inherit (pkgs) system;
    config.allowUnfree = true;
  };
in
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
    pkgs-unstable.claude-code
  ];

  systemd.user.sessionVariables.EDITOR = "nvim";

  services.ssh-agent.enable = true;
}
