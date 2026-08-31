{ pkgs, ... }:
{
  home-manager.users.nick = {
    programs.vscode = {
      enable = true;
      package = pkgs.vscode-fhs;

      profiles.default = {
        userSettings = {
          "editor.fontFamily" = "JetBrainsMono Nerd Font";
          "editor.formatOnSave" = true;
          "files.autoSave" = "onFocusChange";
          "workbench.colorTheme" = "Gruvbox Dark Hard";
        };
        keybindings = [
          { key = "ctrl+shift+k"; command = "editor.action.deleteLines"; }
        ];
        extensions = with pkgs.vscode-extensions; [
          rust-lang.rust-analyzer
          jnoortheen.nix-ide
          jdinhlife.gruvbox
        ];
      };
    };
  };
}
