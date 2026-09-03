{ pkgs, ... }:
{
  home-manager.users.nick = {
    programs.yazi = {
      enable = true;
      enableBashIntegration = true;

      plugins = {
        bookmarks = pkgs.yaziPlugins.bookmarks;
      };

      initLua = ''
        require("bookmarks"):setup({
          last_directory = { enable = false },
          persist = "vim",
          desc_format = "full",
          notify = { enable = true },
        })
      '';

      keymap = {
        mgr.prepend_keymap = [
          {
            on = "!";
            run = ''shell "$SHELL" --block'';
            desc = "Open shell here";
          }
          {
            on = "m";
            run = "plugin bookmarks save";
            desc = "Save current position as a mark";
          }
          {
            on = "'";
            run = "plugin bookmarks jump";
            desc = "Jump to a mark";
          }
          {
            on = [ "b" "d" ];
            run = "plugin bookmarks delete";
            desc = "Delete a mark";
          }
          {
            on = [ "b" "D" ];
            run = "plugin bookmarks delete_all";
            desc = "Delete all marks";
          }
        ];
      };
    };
  };
}
