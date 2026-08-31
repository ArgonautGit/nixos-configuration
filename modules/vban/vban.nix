{ ... }:
{
  services.pipewire.extraConfig.pipewire."99-vban-mic" = {
    "context.modules" = [
      {
        name = "libpipewire-module-vban-send";
        args = {
          "destination.ip" = "win-gaming"; # or the Tailscale/LAN IP
          "sess.name" = "nixos-mic";
          "sess.media" = "audio";
          "audio.format" = "S16LE";
          "audio.rate" = 48000;
          "audio.channels" = 1;
          "node.always-process" = true;
          "stream.props" = {
            "media.class" = "Audio/Sink";
          };
        };
      }
    ];
  };
}
