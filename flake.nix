{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";
    nixpkgs-unstable.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager = {
      url = "github:nix-community/home-manager/release-26.05";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    lazyvim.url = "github:pfassina/lazyvim-nix";
    plasma-manager = {
      url = "github:nix-community/plasma-manager/trunk";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.home-manager.follows = "home-manager";
    };
    # Anthropic's apt index for Claude Desktop; `nix flake update` re-locks it
    # and modules/claude-desktop picks the newest version listed.
    claude-desktop-apt = {
      url = "file+https://downloads.claude.ai/claude-desktop/apt/stable/dists/stable/main/binary-amd64/Packages";
      flake = false;
    };
  };

  outputs = { nixpkgs, home-manager, plasma-manager, ... }@inputs: {
    nixosConfigurations.nixos = nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = { inherit inputs; };
      modules = [
        ./configuration.nix
        home-manager.nixosModules.home-manager
        { home-manager.extraSpecialArgs = { inherit inputs; }; }
        # Plasma-manager is a home-manager module, so it's registered as a
        # sharedModule (imported into every home-manager user's config) rather
        # than imported through NixOS's top-level `imports`.
        { home-manager.sharedModules = [ plasma-manager.homeModules.plasma-manager ]; }
      ];
    };
  };
}
