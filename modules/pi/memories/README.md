# Declarative Pi memories

Add stable, topic-specific notes as Markdown files in this directory. Keep
separate topics in separate files so Pi can read only the note relevant to the
current task. The global `AGENTS.md` points Pi here; Pi does not automatically
load arbitrary files from this directory.

This directory is linked into `~/.pi/agent/memories/` from the Nix store and is
read-only at runtime. Edit the source in `/etc/nixos/modules/pi/memories/` and
rebuild to change it. These files are part of the Nix store, so do not put
credentials, secrets, or other sensitive private data here.
