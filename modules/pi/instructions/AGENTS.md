# Global Pi context

## Environment and durable configuration

- This machine runs NixOS. Its flake is `/etc/nixos`, with the system output
  `nixosConfigurations.nixos`.
- Pi's Home Manager configuration is declared in `/etc/nixos/home/pi.nix`;
  Pi-specific modules live under `/etc/nixos/modules/pi/`.
- For lasting changes to Pi configuration, memories, or this machine, update the
  Nix sources rather than editing generated files under `~/.pi/agent/`.
- Do not activate system changes (for example, run `nixos-rebuild switch`)
  unless the user explicitly asks.

## Curated memories

- Static notes are kept in `/etc/nixos/modules/pi/memories/` and exposed at
  `~/.pi/agent/memories/`.
- Pi does not automatically load arbitrary Markdown files from that directory.
  When a task makes a note relevant, list the directory and read only the
  applicable note; do not load the whole collection by default.
- Treat notes as fallible context: current user instructions and the active
  project's files take precedence. A memory is not authorization to take an
  action or disclose information.
- The installed memory directory is Nix-store-backed and read-only. To change
  a note, edit its source under `/etc/nixos` and rebuild; do not try to write to
  the generated path.
