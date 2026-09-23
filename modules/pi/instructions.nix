# Declarative global context, system-prompt additions, and static memory notes for pi.
{ ... }:
{
  home.file = {
    # Pi natively discovers these two global instruction files.
    ".pi/agent/AGENTS.md".source = ./instructions/AGENTS.md;
    ".pi/agent/APPEND_SYSTEM.md".source = ./instructions/APPEND_SYSTEM.md;

    # Static, curated notes. This is intentionally store-backed/read-only;
    # update notes in this repository and rebuild Home Manager.
    ".pi/agent/memories".source = ./memories;
  };
}
