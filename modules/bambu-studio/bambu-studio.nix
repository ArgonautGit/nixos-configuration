# Use Bambu's prebuilt AppImage instead of compiling the Nixpkgs package.
# The core is AGPL; its proprietary networking plugin still requires allowUnfree.
{ pkgs, ... }:
let
  pname = "bambu-studio";
  version = "02.08.02.61";

  # Pin the Ubuntu 24.04 build, which uses the supported WebKitGTK 4.1 ABI.
  # When updating, replace the release timestamp and hash along with version.
  src = pkgs.fetchurl {
    url = "https://github.com/bambulab/BambuStudio/releases/download/v${version}/BambuStudio_ubuntu24.04-v${version}-20260820225108.AppImage";
    hash = "sha256-1QGxA/rFQkUT7A6Na8FF+zBxneLH2U1zINcjdAyBp/0=";
  };

  appimageContents = pkgs.appimageTools.extract {
    inherit pname version src;
  };

  bambu-studio = pkgs.appimageTools.wrapType2 {
    inherit pname version src;

    # Libraries not bundled in the AppImage or appimageTools' default runtime.
    extraPkgs = p: [
      p.webkitgtk_4_1
      p.glib-networking
      p.gst_all_1.gst-plugins-good
      p.gst_all_1.gst-plugins-bad
    ];

    profile = ''
      # HTTPS for both the application and its downloaded networking plugin.
      export SSL_CERT_FILE="''${SSL_CERT_FILE:-${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt}"
      export CURL_CA_BUNDLE="''${CURL_CA_BUNDLE:-$SSL_CERT_FILE}"
      export GIO_EXTRA_MODULES="${pkgs.glib-networking}/lib/gio/modules''${GIO_EXTRA_MODULES:+:$GIO_EXTRA_MODULES}"

      # Match the Nixpkgs package's WebKit login/rendering workarounds.
      export WEBKIT_DISABLE_COMPOSITING_MODE=1
      export WEBKIT_DISABLE_DMABUF_RENDERER=1
    '';

    extraInstallCommands = ''
      install -Dm644 ${appimageContents}/BambuStudio.desktop \
        $out/share/applications/BambuStudio.desktop
      substituteInPlace $out/share/applications/BambuStudio.desktop \
        --replace-fail 'Exec=AppRun %U' "Exec=$out/bin/${pname} %U"
      install -Dm644 ${appimageContents}/BambuStudio.png \
        $out/share/icons/hicolor/192x192/apps/BambuStudio.png
    '';

    meta = {
      description = "Bambu Lab 3D printer slicer (upstream AppImage)";
      homepage = "https://github.com/bambulab/BambuStudio";
      license = with pkgs.lib.licenses; [
        agpl3Plus
        unfree
      ];
      mainProgram = pname;
      platforms = [ "x86_64-linux" ];
    };
  };
in
{
  environment.systemPackages = [ bambu-studio ];
}
