# Declarative FreeCAD MCP integration

A portable **Linux Home Manager** module. Host-specific wiring is only:

```nix
{
  imports = [ ../modules/freecad ];
  programs.freecadMcp.enable = true;
}
```

The module owns the FreeCAD package; do not also install plain `pkgs.freecad`
in that Home Manager configuration. It accepts ordinary `config`, `lib`, and
`pkgs` arguments and does not depend on this repository's flake inputs, username,
project directory, or global `packages.nix`. The supplied FreeCAD package must
support nixpkgs' `freecad.customize` interface.

The module owns the **whole** `~/.config/mcp/mcp.json` file. If another module
already manages that file or you need other MCP servers, consolidate the
configuration under one owner before enabling this module; it does not merge
existing JSON from disk.

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

Version 6.1.0 uses MCP 1.x. The supplied nixpkgs must have an MCP SDK recipe
**>= 1.26.0 within the 1.x major version**:

- Recipes below 1.28.1 receive a local SDK 1.29.0 override, without changing the
  host's Python package set. The fallback was tested against the 1.26.0 recipe.
- Compatible SDKs >= 1.28.1 are used directly from nixpkgs.
- Older recipes and other major versions (including 2.x prereleases) fail with
  an explicit evaluation error instead of inheriting incompatible dependencies
  or build hooks. This is a compatibility guard, not a claim that every nixpkgs
  revision in that range has been tested.

The add-on's newer 7.x releases require a separate MCP 2.x dependency stack.
Use compatible nixpkgs, or override `programs.freecadMcp.package` with a suitable
backend whose `src/AICopilot` supplies its matching add-on. `freecadPackage` can
also be overridden with a package supporting `customize`.

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
5. For visual feedback, have the agent save the viewport as a PNG through
   FreeCAD's API, then inspect that file with pi's `read` tool. The upstream
   `view_control` screenshot operation returns **base64 inside JSON text**, not
   a native MCP image block; receiving that text is not visual verification.

The add-on discovers instances through per-user records. With multiple FreeCAD
instances open, inspect the available instances and select the intended one
before making changes. Do not let multiple agents edit the same document.

## Validation and limitations

Live integration tests of the **new backend** passed with FreeCAD 1.1.3,
freecad-mcp 6.1.0 and pi-mcp-adapter 2.32.1:

- Ordinary FreeCAD startup automatically loads AICopilot; pi discovers 36 tools.
- The GUI's Unix socket has mode 0600, with no TCP listener observed.
- Primitive creation, Boolean cuts, topology checks, parameter edits and
  FCStd save/reopen preserve editable feature history.
- A six-component native hinge assembly solves at 0, 30, 60 and 90 degrees,
  with valid solids and no volumetric overlap across all 15 pairs at each pose.
- Arm length changes from 44 to 54 mm work; the pose and dimension checks also
  pass after saving, closing and reopening the assembly.
- STEP export/readback preserves solids, volumes and component positions.
- Saved viewport PNGs were read and visually inspected. Original CAD files
  were preserved by testing on a copy.

For an assembly's `App::Link` components, use the link-aware `Import.export`;
`Part.export` produced an empty STEP file for those inputs during testing.
The startup log warns that CAM tools need a newer Path Toolbit API; CAM was
not tested. These checks are live smoke/regression tests, not a complete
upstream unit-test suite or a security audit. Sampled poses do not establish
collision-free continuous motion or a manufacturing-ready design.

## Security and migration

On Linux, this add-on uses a **Unix-domain socket with mode 0600**, rather than
the previous token-authenticated localhost HTTP bridge. No TCP listener,
firewall opening, token file or token-generation script is needed. This is
single-user local automation, not a sandbox: agents using it have your user
account's access through FreeCAD's scripting API. Open only trusted CAD files.

The old `freecad-astra` and `mcpfreecad-local` commands are removed on activation.
Existing CAD documents and old runtime credentials/library files are not deleted;
`~/.config/mcpfreecad/local.json` is simply unused by this replacement.
The validation above covers this replacement, not just the earlier tspspi
bridge. Repeat the smoke test when changing nixpkgs, FreeCAD or the backend.

No changes to root `packages.nix`, `configuration.nix`, or the flake inputs are
required. No system switch or live CAD test is performed by editing this module.

Upstream: https://github.com/blwfish/freecad-mcp
