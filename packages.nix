{ pkgs, ... }:
{

  nixpkgs.config.allowUnfree = true;

  environment.systemPackages = with pkgs; [
    # Essentials
    vim
    wget
    unzip
    zip
    git
    cmake
    gcc
    gcc-arm-embedded
    ffmpeg
    imagemagick
  ];

  programs.firefox.enable = true;
}
