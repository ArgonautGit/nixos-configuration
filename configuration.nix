# Edit this configuration file to define what should be installed on
# your system.  Help is available in the configuration.nix(5) man page
# and in the NixOS manual (accessible by running ‘nixos-help’).

{
  pkgs,
  inputs,
  ...
}:

{
  nix.settings.experimental-features = [
    "nix-command"
    "flakes"
  ];

  # Override NixOS's built-in default (EDITOR=nano) so everything —
  # login shells, the Plasma/systemd user session, yazi — uses nvim.
  environment.sessionVariables.EDITOR = "nvim";

  imports = [
    # Include the results of the hardware scan.
    ./hardware-configuration.nix
    ./packages.nix
    ./modules/lazyvim/lazyvim.nix
    ./modules/vscode/vscode.nix
    # ./modules/moonlight/moonlight.nix
    ./modules/moonlight-mic/moonlight-mic.nix
    ./modules/docker/docker.nix
    ./modules/yazi/yazi.nix
    ./modules/tailscale/tailscale.nix
    ./modules/chatgpt-desktop/chatgpt-desktop.nix
  ];

  # Update flake.lock and activate rebuilds manually; this checkout may be
  # on a development branch and must not be deployed unattended.
  system.autoUpgrade.enable = false;

  home-manager.backupFileExtension = "bak";
  home-manager.overwriteBackup = true;
  home-manager.useGlobalPkgs = true;
  home-manager.useUserPackages = true;
  home-manager.users.nick = import ./home/nick.nix;

  nixpkgs.overlays = [
    (final: prev: {
      pi-coding-agent =
        inputs.nixpkgs-unstable.legacyPackages.${prev.stdenv.hostPlatform.system}.pi-coding-agent.overrideAttrs
          (old: {
            postFixup = (old.postFixup or "") + ''
              wrapProgram $out/bin/pi --suffix PATH : ${final.lib.makeBinPath [ final.nodejs ]}
            '';
          });
    })
  ];

  # Enable appimage support
  programs.appimage = {
    enable = true;
    binfmt = true;
  };

  # Bootloader.
  boot.loader.systemd-boot.enable = true;
  boot.loader.efi.canTouchEfiVariables = true;

  # Compressed swap provides headroom during memory-intensive workloads.
  zramSwap.enable = true;

  networking.hostName = "nixos"; # Define your hostname.
  # networking.wireless.enable = true;  # Enables wireless support via wpa_supplicant.

  # Configure network proxy if necessary
  # networking.proxy.default = "http://user:password@proxy:port/";
  # networking.proxy.noProxy = "127.0.0.1,localhost,internal.domain";

  # Enable networking
  networking.networkmanager.enable = true;

  # Set your time zone.
  time.timeZone = "America/New_York";

  # Select internationalisation properties.
  i18n.defaultLocale = "en_US.UTF-8";

  i18n.extraLocaleSettings = {
    LC_ADDRESS = "en_US.UTF-8";
    LC_IDENTIFICATION = "en_US.UTF-8";
    LC_MEASUREMENT = "en_US.UTF-8";
    LC_MONETARY = "en_US.UTF-8";
    LC_NAME = "en_US.UTF-8";
    LC_NUMERIC = "en_US.UTF-8";
    LC_PAPER = "en_US.UTF-8";
    LC_TELEPHONE = "en_US.UTF-8";
    LC_TIME = "en_US.UTF-8";
  };

  # Enable the X11 windowing system.
  # You can disable this if you're only using the Wayland session.
  services.xserver.enable = true;

  # Enable the KDE Plasma Desktop Environment.
  services.displayManager.sddm.enable = true;
  services.desktopManager.plasma6.enable = true;

  # Configure keymap in X11
  services.xserver.xkb = {
    layout = "us";
    variant = "";
  };

  # Enable CUPS to print documents.
  services.printing.enable = true;

  # Enable sound with pipewire.
  services.pulseaudio.enable = false;
  security.rtkit.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
    # If you want to use JACK applications, uncomment this
    #jack.enable = true;

    # use the example session manager (no others are packaged yet so this is enabled by default,
    # no need to redefine it in your config for now)
    #media-session.enable = true;
  };

  # Enable touchpad support (enabled default in most desktopManager).
  # services.xserver.libinput.enable = true;

  # Define a user account. Don't forget to set a password with ‘passwd’.
  users.users."nick" = {
    isNormalUser = true;
    description = "nick";
    extraGroups = [
      "networkmanager"
      "wheel"
      "dialout"
    ];
  };

  # Bind capslock to escape.
  services.xserver.xkb.options = "caps:escape";
  console.useXkbConfig = true; # optional: applies to TTYs too

  hardware.bluetooth.enable = true;
  hardware.bluetooth.powerOnBoot = true;
  # services.blueman.enable = true; # GUI/tray applet; skip if your DE (GNOME/KDE) has its own

  # Some programs need SUID wrappers, can be configured further or are
  # started in user sessions.
  # programs.mtr.enable = true;
  # programs.gnupg.agent = {
  #   enable = true;
  #   enableSSHSupport = true;
  # };

  # List services that you want to enable:

  # Enable the OpenSSH daemon.
  # services.openssh.enable = true;

  # Open ports in the firewall.
  # networking.firewall.allowedTCPPorts = [ ... ];
  # networking.firewall.allowedUDPPorts = [ ... ];
  # Or disable the firewall altogether.
  # networking.firewall.enable = false;

  # This value determines the NixOS release from which the default
  # settings for stateful data, like file locations and database versions
  # on your system were taken. It‘s perfectly fine and recommended to leave
  # this value at the release version of the first install of this system.
  # Before changing this value read the documentation for this option
  # (e.g. man configuration.nix or on https://nixos.org/nixos/options.html).
  system.stateVersion = "26.05"; # Did you read the comment?

}
