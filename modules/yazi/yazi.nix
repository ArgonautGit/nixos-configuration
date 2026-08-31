{ ... }:
{
  home-manager.users.nick = {
    programs.yazi = {
      enable = true;
      enableBashIntegration = true;

      keymap = {
        mgr.prepend_keymap = [
          {
            on = "!";
            run = ''shell "$SHELL" --block'';
            desc = "Open shell here";
          }
        ];
      };
    };
  };
}
