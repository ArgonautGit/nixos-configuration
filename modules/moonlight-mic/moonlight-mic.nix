# moonlight-mic.nix — patched Moonlight client with mic passthrough
# https://github.com/JimothySnicket/moonlight-mic
{ pkgs, ... }:

let
  version = "0.1.0";

  releaseZip = pkgs.fetchurl {
    url = "https://github.com/JimothySnicket/moonlight-mic/releases/download/v${version}/Moonlight-Linux-v${version}.zip";
    hash = "sha256-VLxr5byjhqquTtFEXK6XyjG68xpAF3WMJxpnBeOeIaA=";
  };

  # The zip wraps the AppImage in an installer-release/ dir
  appimage =
    pkgs.runCommand "moonlight-mic-${version}.AppImage" { nativeBuildInputs = [ pkgs.unzip ]; }
      ''
        unzip ${releaseZip} -d tmp
        install -m755 tmp/installer-release/Moonlight-*.AppImage $out
      '';

  moonlight-mic = pkgs.appimageTools.wrapType2 {
    pname = "moonlight-mic";
    inherit version;
    src = appimage;

    extraInstallCommands = ''
      source ${pkgs.makeWrapper}/nix-support/setup-hook
      wrapProgram $out/bin/moonlight-mic \
        --set LIBVA_DRIVERS_PATH /run/opengl-driver/lib/dri \
        --set LIBVA_DRIVER_NAME iHD

      mkdir -p $out/share/applications
      cat > $out/share/applications/moonlight-mic.desktop <<EOF
      [Desktop Entry]
      Name=Moonlight (mic)
      Exec=moonlight-mic
      Icon=moonlight
      Type=Application
      Categories=Game;
      EOF
    '';
  };
in
{
  environment.systemPackages = [ moonlight-mic ];

  # Iris Xe VA-API decode — harmless if you already set this elsewhere
  hardware.graphics = {
    enable = true;
    extraPackages = with pkgs; [ intel-media-driver ];
  };
}
