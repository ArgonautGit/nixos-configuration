{ inputs, pkgs, ... }:
{

  fonts.packages = [ pkgs.nerd-fonts.jetbrains-mono ];

  home-manager.users.nick = {
    imports = [ inputs.lazyvim.homeManagerModules.default ];
    programs.lazyvim = {
      enable = true;
      extras.lang.nix.enable = true;
      extraPackages = with pkgs; [
        nixd
        nixfmt
      ];
      configFiles = ./config;

      extras.lang.rust = {
        enable = true;
        installDependencies = true;
        installRuntimeDependencies = false;
      };
    };
  };
}
