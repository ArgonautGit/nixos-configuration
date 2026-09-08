# BambuStudio — slicer / printer software for BambuLab 3D printers.
#
# Packaged in nixpkgs (bambu-studio); marked unfree (Bambu's custom UI/binary
# components) so it requires nixpkgs.config.allowUnfree = true — already set
# in ./packages.nix.
#
# Connection: Bambu printers primarily use LAN/cloud mode, so no udev rules
# are strictly required. For USB/serial (older X1/MCU flashing) add:
#   services.udev.packages = [ pkgs.fdm-printer-support ];
{ pkgs, ... }:
{
  environment.systemPackages = [ pkgs.bambu-studio ];
}