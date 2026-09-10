# Nix packaging for upstream blwfish/freecad-mcp. No local Python glue.
{
  lib,
  stdenvNoCC,
  fetchFromGitHub,
  fetchPypi,
  makeWrapper,
  python3,
}:
let
  ps = python3.pkgs;

  # The add-on's 6.1 release needs MCP >= 1.28.1. Keep it on the 1.x SDK;
  # the add-on's 7.x releases require the separate MCP 2.x dependency stack.
  # Supply the SDK update locally when using older stable nixpkgs, without
  # importing another flake or changing the host's Python package set.
  mcpSdk =
    if lib.versionAtLeast ps.mcp.version "1.28.1" && lib.versionOlder ps.mcp.version "2.0" then
      ps.mcp
    else
      ps.mcp.overridePythonAttrs (old: {
        version = "1.29.0";
        src = fetchFromGitHub {
          owner = "modelcontextprotocol";
          repo = "python-sdk";
          tag = "v1.29.0";
          hash = "sha256-lRlj5RT/R5zrYL5XpdQR2l9t99G94WTsubN0gSQekMc=";
        };
        dependencies = old.dependencies ++ [ ps.typing-extensions ps.typing-inspection ];
      });

  mcpEvents = ps.buildPythonPackage {
    pname = "mcp-events";
    version = "0.1.0";
    pyproject = true;
    src = fetchPypi {
      pname = "mcp_events";
      version = "0.1.0";
      hash = "sha256-2cJq3eX6H3xRHYIHojYbieeMjcoLpxI0AWjn9XKaD7g=";
    };
    build-system = [ ps.hatchling ];
    pythonImportsCheck = [ "mcp_events" ];
    meta.license = lib.licenses.mit;
  };

  runtime = python3.withPackages (_: [ mcpSdk mcpEvents ]);
in
stdenvNoCC.mkDerivation {
  pname = "freecad-mcp";
  version = "6.1.0";

  # The server and the FreeCAD add-on always come from the same pinned source.
  src = fetchFromGitHub {
    owner = "blwfish";
    repo = "freecad-mcp";
    rev = "766eab6a9486395781e5124d9eed2e9b81f6aa44"; # v6.1.0
    hash = "sha256-0Z1kN01s/YO9pPIcaUIsLcMfI37kTqYtscRMaVhrtW8=";
  };

  # Upstream intentionally ships flat scripts, not an installable wheel.
  # Keep its sibling modules together in the store; only install an entrypoint.
  dontUnpack = true;
  dontBuild = true;
  nativeBuildInputs = [ makeWrapper ];
  installPhase = ''
    runHook preInstall
    mkdir -p "$out/bin"
    makeWrapper ${runtime}/bin/python "$out/bin/freecad-mcp" \
      --add-flags "$src/freecad_mcp_server.py"
    runHook postInstall
  '';

  meta = {
    description = "MCP server and auto-starting FreeCAD AI Copilot add-on";
    homepage = "https://github.com/blwfish/freecad-mcp";
    license = lib.licenses.lgpl21Plus;
    platforms = lib.platforms.linux;
    mainProgram = "freecad-mcp";
  };
}
