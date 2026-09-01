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

      extras.lang.clangd = {
        enable = true;
        installDependencies = true; # clangd + clang-format, codelldb debugger
        installRuntimeDependencies = false;
      };

      extras.lang.cmake = {
        enable = true;
        installDependencies = true; # cmake-language-server
      };
    };
  };
}
