# Declarative FreeCAD MCP integration

A portable Home Manager module. Host-specific wiring is only:

```nix
{
  imports = [ ../modules/freecad ];
  programs.freecadMcp.enable = true;
}
```

The module owns the FreeCAD package; do not also install plain `pkgs.freecad`
in that Home Manager configuration. It accepts ordinary `config`, `lib`, and
`pkgs` arguments and does not depend on this repository's flake inputs, username,
project directory, or global `packages.nix`.

## What Nix manages

- `package.nix`: pinned upstream **blwfish/freecad-mcp 6.1.0**, its matching
  AICopilot add-on, and the external server's dependencies.
- `default.nix`: the usual FreeCAD executable/desktop entry, with the add-on
  included through nixpkgs' `freecad.customize`; plus `~/.config/mcp/mcp.json`.
- Upstream's add-on starts automatically when the FreeCAD GUI opens and works
  across workbenches. No custom Python files, generated Python snippets,
  `.FCMacro`, token-generation helper, venv, pip installation, or special
  `freecad-astra` launcher is maintained here.

The upstream software is written in Python; Nix installs its interpreter and
libraries as normal package dependencies. The server environment is separate
from FreeCAD's embedded interpreter and Qt libraries.

Version 6.1.0 uses MCP 1.x. If the supplied nixpkgs has an older SDK, the package
provides a local 1.29.0 override without changing the host's Python package set.
The add-on's newer 7.x releases require a separate MCP 2.x dependency stack.
`programs.freecadMcp.package` and `freecadPackage` can be overridden by the caller.

Pi's adapter is a separate client concern: the existing `home/pi.nix` setting
pins `npm:pi-mcp-adapter@2.32.1`. Pi still downloads that adapter and its npm
dependencies on first startup; this module does not claim to Nix-lock them.

## Use after rebuilding

1. Save your CAD documents and fully quit existing FreeCAD processes.
2. Open **FreeCAD** normally (CLI or desktop entry).
3. Restart pi to load the changed server configuration. If necessary, use
   `/mcp reconnect freecad` to discard the old tool catalog.
4. Ask pi to discover the FreeCAD tools and call `check_freecad_connection`.
   This backend has different tools from the previous tspspi bridge:
   `bridge_status` and its other old tool names no longer apply.
5. Check that screenshots arrive as actual images, then make a new test document.

The add-on discovers instances through per-user records. With multiple FreeCAD
instances open, inspect the available instances and select the intended one
before making changes. Do not let multiple agents edit the same document.

## Security and migration

On Linux, this add-on uses a **Unix-domain socket with mode 0600**, rather than
the previous token-authenticated localhost HTTP bridge. No TCP listener,
firewall opening, token file or token-generation script is needed. This is
single-user local automation, not a sandbox: agents using it have your user
account's access through FreeCAD's scripting API. Open only trusted CAD files.

The old `freecad-astra` and `mcpfreecad-local` commands are removed on activation.
Existing CAD documents and old runtime credentials/library files are not deleted;
`~/.config/mcpfreecad/local.json` is simply unused by this replacement.
The earlier hinge test validated the old bridge, **not** this new backend.
Build and repeat the GUI/assembly smoke test before treating migration as tested.

No changes to root `packages.nix`, `configuration.nix`, or the flake inputs are
required. No system switch or live CAD test is performed by editing this module.

Upstream: https://github.com/blwfish/freecad-mcp
