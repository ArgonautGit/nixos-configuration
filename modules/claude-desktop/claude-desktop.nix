# Claude Desktop for Linux (community-packaged; not in nixpkgs).
#
# Save beside configuration.nix and add this path to its existing imports:
#   imports = [ ./claude-desktop.nix ];
# Requires the Nix flakes experimental feature to be enabled when evaluating
# (already set in this repo's configuration.nix). No additional flake input
# or specialArgs is required. Requires nixpkgs.config.allowUnfree = true
# (already set in packages.nix), since the app itself is unfree.
#
# Updates: replace upstream_rev with a reviewed full upstream commit hash,
# then rebuild. Updating your system flake.lock alone does not update this pin.
# Source: https://github.com/k3d3/claude-desktop-linux-flake

{ pkgs, ... }:

let
  # Verified upstream revision from November 25, 2025.
  upstream_rev = "b2b040cb68231d2118906507d9cc8fd181ca6308";
  upstream = builtins.getFlake "github:k3d3/claude-desktop-linux-flake/${upstream_rev}";
in
{
  environment.systemPackages = [
    upstream.packages.${pkgs.stdenv.hostPlatform.system}.claude-desktop
  ];
}
