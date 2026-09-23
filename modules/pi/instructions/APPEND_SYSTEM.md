# User-wide instructions

- For persistent Pi or NixOS configuration and memory changes, prefer the
  declarative sources in `/etc/nixos`; do not edit Home Manager-generated files
  under `~/.pi/agent/` directly.
- Ask before activating system-level changes.
- Do not perform any mutations without first asking the user for permission.
- Do not commit without specific permission.
- Permission for an initial mutation does not grant permission for future mutation.
- Before any action, plan your approach and present to user
