# Portable Home Manager module. Import it and enable programs.freecadMcp.
{ config, lib, pkgs, ... }:
let
  cfg = config.programs.freecadMcp;
  freecad = cfg.freecadPackage.customize {
    modules = [ "${cfg.package.src}/AICopilot" ];
  };
in
{
  options.programs.freecadMcp = {
    enable = lib.mkEnableOption "FreeCAD with its auto-starting MCP add-on";

    package = lib.mkOption {
      type = lib.types.package;
      default = pkgs.callPackage ./package.nix { };
      defaultText = lib.literalExpression "pkgs.callPackage ./package.nix { }";
      description = "MCP backend package whose src also supplies the AICopilot add-on.";
    };

    freecadPackage = lib.mkPackageOption pkgs "freecad" { };
  };

  config = lib.mkIf cfg.enable {
    # Nixpkgs' FreeCAD customization keeps the ordinary CLI and desktop entry.
    # Upstream's InitGui starts the add-on; no local macro or launcher is needed.
    home.packages = [ freecad cfg.package ];

    # Shared MCP format: usable by pi-mcp-adapter or other compatible clients.
    xdg.configFile."mcp/mcp.json".text = builtins.toJSON {
      mcpServers.freecad = {
        command = lib.getExe cfg.package;
        lifecycle = "lazy-keep-alive";
        requestTimeoutMs = 180000;
        env = {
          FREECAD_MCP_FREECAD_BIN = lib.getExe' freecad "FreeCAD";
          FREECAD_MCP_MODULE_DIR = "${cfg.package.src}/AICopilot";
        };
      };
    };
  };
}
