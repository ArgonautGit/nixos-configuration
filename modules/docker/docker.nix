{
  virtualisation.docker.enable = true;
  users.users.nick.extraGroups = [ "docker" ];

  # Periodic cleanup.
  virtualisation.docker.autoPrune.enable = true;
}
