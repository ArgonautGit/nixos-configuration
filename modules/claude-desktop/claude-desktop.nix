# Claude Desktop for Linux — Anthropic's official Linux beta (Chat, Cowork and
# Claude Code), repackaged from their apt repository. Not in nixpkgs.
#
# Save beside configuration.nix and add this path to its existing imports:
#   imports = [ ./claude-desktop.nix ];
# Requires the `claude-desktop-apt` input in flake.nix (Anthropic's apt
# Packages index) and nixpkgs.config.allowUnfree = true (already set in
# packages.nix), since the app itself is unfree.
#
# Updates: the app can't self-update from the Nix store. `nix flake update`
# (or `nix flake update claude-desktop-apt`) re-locks the apt index; the newest
# claude-desktop entry in it, with its SHA256, is what gets built.
# Linux beta limitations: https://code.claude.com/docs/en/desktop-linux

{ inputs, lib, pkgs, ... }:

let
  # Parse the Debian Packages index into one attrset per stanza.
  aptIndex = builtins.readFile inputs.claude-desktop-apt;
  stanzas = map (
    stanza:
    builtins.listToAttrs (
      map (
        line:
        let
          m = builtins.match "([A-Za-z0-9-]+): (.*)" line;
        in
        lib.nameValuePair (builtins.elemAt m 0) (builtins.elemAt m 1)
      ) (builtins.filter (line: builtins.match "[A-Za-z0-9-]+: .*" line != null) (lib.splitString "\n" stanza))
    )
  ) (lib.splitString "\n\n" aptIndex);
  releases = builtins.filter (s: (s.Package or null) == "claude-desktop" && (s.Architecture or null) == "amd64") stanzas;
  latest = lib.last (builtins.sort (a: b: builtins.compareVersions a.Version b.Version < 0) releases);

  # dlopen()ed at runtime rather than linked, so autoPatchelf can't see them.
  runtimeLibs = with pkgs; [
    libGL
    libnotify
    libsecret
    libayatana-appindicator
    libxtst
    libuuid
    pipewire
    vulkan-loader
  ];

  claude-desktop = pkgs.stdenvNoCC.mkDerivation {
    pname = "claude-desktop";
    version = latest.Version;

    src = pkgs.fetchurl {
      url = "https://downloads.claude.ai/claude-desktop/apt/stable/${latest.Filename}";
      sha256 = latest.SHA256;
    };

    nativeBuildInputs = with pkgs; [
      dpkg
      makeWrapper
      autoPatchelfHook
    ];

    buildInputs = with pkgs; [
      alsa-lib
      at-spi2-atk
      at-spi2-core
      cairo
      cups
      dbus
      expat
      glib
      gtk3
      libcap_ng
      libgbm
      libseccomp
      libxkbcommon
      nspr
      nss
      pango
      systemdLibs
      libx11
      libxcb
      libxcomposite
      libxdamage
      libxext
      libxfixes
      libxrandr
      stdenv.cc.cc.lib
    ];

    dontConfigure = true;
    dontBuild = true;

    # dpkg-deb -x tries to restore the setuid bit on chrome-sandbox, which the
    # build sandbox refuses.
    unpackPhase = ''
      runHook preUnpack
      dpkg-deb --fsys-tarfile $src | tar --no-same-permissions --no-same-owner -x
      runHook postUnpack
    '';

    installPhase = ''
      runHook preInstall

      mkdir -p $out/lib $out/bin
      cp -r usr/lib/claude-desktop $out/lib/claude-desktop
      cp -r usr/share $out/share
      rm -rf $out/share/lintian $out/share/doc

      # A setuid helper can't live in the Nix store; without it Chromium uses
      # its user-namespace sandbox instead.
      rm $out/lib/claude-desktop/chrome-sandbox

      # --set (not --prefix) so a browser's LD_LIBRARY_PATH can't leak into the
      # claude:// login callback it launches and break the process.
      makeWrapper $out/lib/claude-desktop/claude-desktop $out/bin/claude-desktop \
        --set LD_LIBRARY_PATH "${lib.makeLibraryPath runtimeLibs}" \
        --prefix PATH : "${lib.makeBinPath [ pkgs.qemu_kvm pkgs.xdg-utils ]}"

      runHook postInstall
    '';

    meta = {
      description = "Claude Desktop (official Linux beta)";
      homepage = "https://claude.ai/download";
      license = lib.licenses.unfree;
      sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
      platforms = [ "x86_64-linux" ];
      mainProgram = "claude-desktop";
    };
  };
in
{
  environment.systemPackages = [ claude-desktop ];

  # The desktop entry was renamed from claude.desktop (community build).
  xdg.mime.defaultApplications."x-scheme-handler/claude" = "com.anthropic.Claude.desktop";

  # Cowork's VM hardcodes Debian's UEFI firmware path. The app's asar has
  # integrity validation enabled, so provide the path rather than patch it.
  systemd.tmpfiles.rules = [
    "d /usr/share/OVMF 0755 root root -"
    "L+ /usr/share/OVMF/OVMF_CODE.fd - - - - ${pkgs.OVMF.fd}/FV/OVMF_CODE.fd"
  ];
}
