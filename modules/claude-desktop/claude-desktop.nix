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
  claude-desktop-upstream = upstream.packages.${pkgs.stdenv.hostPlatform.system}.claude-desktop;

  # The upstream Linux stub for the macOS-only `claude-native` module lacks
  # `AuthRequest`, so "Continue with Google" throws
  # "Cannot read properties of undefined (reading 'isAvailable')" and spins
  # forever. Reporting it as unavailable makes the app fall back to opening
  # the system browser, which returns via the claude:// URL handler.
  # Drop this once upstream's stub provides AuthRequest.
  claude-desktop = pkgs.runCommand "claude-desktop-${claude-desktop-upstream.version or "patched"}" {
    nativeBuildInputs = [ pkgs.asar ];
    inherit (claude-desktop-upstream) meta;
  } ''
    src=${claude-desktop-upstream}
    mkdir -p $out/lib/claude-desktop $out/bin
    cp -r $src/share $out/share

    asar extract $src/lib/claude-desktop/app.asar app
    chmod -R u+w app
    cat >> app/node_modules/claude-native/index.js <<'EOF'

// NixOS patch: stub macOS-only ASWebAuthenticationSession binding.
if (!module.exports.AuthRequest) {
  module.exports.AuthRequest = { isAvailable: () => false };
}
EOF

    # The main window is frameless ("hidden" title bar) with window controls
    # only on Windows, leaving Linux with an empty strip, no buttons and square
    # corners. On Linux, use the native KDE frame instead (rounded corners,
    # theme buttons), hide the menu bar until Alt is pressed, and let the
    # claude.ai view cover the app's now-redundant strip.
    # The claude.ai view is only re-laid-out on "resize", which Electron on
    # Linux/X11 doesn't reliably emit for maximize/fullscreen, leaving the
    # page stuck at its old size in a corner of the window.
    substituteInPlace app/.vite/build/index.js \
      --replace-fail 'titleBarStyle:"hidden",titleBarOverlay:Xi,' \
                     '...(process.platform==="linux"?{autoHideMenuBar:!0}:{titleBarStyle:"hidden",titleBarOverlay:Xi}),' \
      --replace-fail 'u=e2+(Xi?1:0)' 'u=process.platform==="linux"?0:e2+(Xi?1:0)' \
      --replace-fail 'e.on("resize",()=>{i(),o()})' \
                     '["resize","maximize","unmaximize","enter-full-screen","leave-full-screen"].forEach(v=>e.on(v,()=>{i(),o(),setTimeout(()=>{i(),o()},100)}))'
    asar pack app $out/lib/claude-desktop/app.asar --unpack "*.node"

    # Browsers (e.g. Firefox) launch the claude:// login callback with their
    # own LD_LIBRARY_PATH, which pulls in a mismatched glibc and makes
    # Electron abort before it can forward the URL to the running app.
    substitute $src/bin/claude-desktop $out/bin/claude-desktop \
      --replace-fail "$src/lib/claude-desktop/app.asar" "$out/lib/claude-desktop/app.asar"
    sed -i '1a unset LD_LIBRARY_PATH' $out/bin/claude-desktop
    chmod +x $out/bin/claude-desktop
  '';
in
{
  environment.systemPackages = [ claude-desktop ];
}
