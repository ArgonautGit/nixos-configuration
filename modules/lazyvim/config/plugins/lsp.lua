return {
      "neovim/nvim-lspconfig",
      opts = {
        servers = {
          nil_ls = { enabled = false },
          nixd = {
            settings = {
              nixd = {
                nixpkgs = { expr = "import (builtins.getFlake \"/etc/nixos\").inputs.nixpkgs { }" },
                formatting = { command = { "nixfmt" } },
                options = {
                  nixos = {
                    expr = "(builtins.getFlake \"/etc/nixos\").nixosConfigurations.nixos.options",
                  },
                  home_manager = {
                    expr = "(builtins.getFlake \"/etc/nixos\").nixosConfigurations.nixos.options.home-manager.users.type.getSubOptions []",
                  },
                },
              },
            },
          },
        },
      },
    }
