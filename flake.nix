{
  description = "synoptic-github — regenerate GitHub profile README";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # Stage 1 (FOD): fetch npm packages — pure JS output, no store-path refs allowed.
        # After changing deps, run:
        #   nix build "path:."#synoptic 2>&1 | grep "got:" | awk '{print $2}'
        # and paste the result into outputHash below.
        nodeModules = pkgs.stdenv.mkDerivation {
          name = "synoptic-github-modules";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [ ./package.json ./bun.lock ];
          };
          nativeBuildInputs = [ pkgs.bun ];
          # Allow SSL cert env vars to be inherited from the build host (standard FOD pattern).
          impureEnvVars = pkgs.lib.fetchers.proxyImpureEnvVars ++ [
            "NIX_SSL_CERT_FILE" "SSL_CERT_FILE" "GIT_SSL_CAINFO"
          ];
          buildPhase = ''
            export HOME=$TMPDIR
            bun install --frozen-lockfile
          '';
          installPhase = "cp -r node_modules $out";
          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
          outputHash = "sha256-VK8y/94pmdVy7ROvfkxS79ZoMHHaSeMsgAemal8RImc=";
        };

        # Stage 2: compile to self-contained binary using the fetched modules.
        # Regular derivation — may reference store paths in the output (fine, not a FOD).
        synoptic = pkgs.stdenv.mkDerivation {
          pname = "synoptic-github";
          version = "2.0.0";
          src = pkgs.lib.cleanSource ./.;
          nativeBuildInputs = [ pkgs.bun ];
          buildPhase = ''
            export HOME=$TMPDIR
            ln -s ${nodeModules} node_modules
            bun build --compile --outfile=synoptic-github ./synoptic.ts
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp synoptic-github $out/bin/
          '';
        };

        # Runtime source tree for the container: TypeScript sources + pre-fetched
        # node_modules symlink so `bun run synoptic.ts` works without network access.
        # The compiled binary has a bun 1.3.13 quirk (prints help text and exits 0
        # without running the embedded script), so the container uses `bun run` instead.
        synopticRuntime = pkgs.stdenv.mkDerivation {
          name = "synoptic-github-runtime";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./synoptic.ts ./render.ts ./status.ts ./schema.ts ./vocabulary.ts ./languages.ts
              ./package.json
            ];
          };
          buildPhase = "true";
          installPhase = ''
            mkdir -p $out
            cp synoptic.ts render.ts status.ts schema.ts vocabulary.ts languages.ts package.json $out/
            ln -s ${nodeModules} $out/node_modules
          '';
        };

        # Advisory tools (follows / lists / value / curate / components-probe) —
        # local-only, not in the container. No external npm deps (only node
        # built-ins + cross-imports), so no FOD needed. Each binary is
        # self-contained: bun bundles all transitive imports at compile time.
        tools = pkgs.stdenv.mkDerivation {
          pname = "synoptic-tools";
          version = "1.0.0";
          src = pkgs.lib.fileset.toSource {
            root = ./.;
            fileset = pkgs.lib.fileset.unions [
              ./follows.mjs ./lists.mjs ./value.mjs ./curate.mjs ./components-probe.mjs
            ];
          };
          nativeBuildInputs = [ pkgs.bun ];
          buildPhase = ''
            export HOME=$TMPDIR
            bun build --compile --outfile=follows         follows.mjs
            bun build --compile --outfile=lists           lists.mjs
            bun build --compile --outfile=value           value.mjs
            bun build --compile --outfile=curate          curate.mjs
            bun build --compile --outfile=components-probe components-probe.mjs
          '';
          installPhase = ''
            mkdir -p $out/bin
            cp follows lists value curate components-probe $out/bin/
          '';
        };

        # Render + commit entrypoint used inside the container.
        # SOURCE_DATE_EPOCH is derived from the consumer repo's last commit
        # (same logic as the old composite "Source epoch" step).
        entrypoint = pkgs.writeShellScript "entrypoint" ''
          set -euo pipefail
          # GitHub Actions mounts the workspace owned by the runner user; inside the
          # container we run as root — git refuses unless we mark it safe.
          ${pkgs.git}/bin/git config --global --add safe.directory '*'
          export SOURCE_DATE_EPOCH=$(${pkgs.git}/bin/git log -1 --format=%ct)
          # Hydrate bare env names from INPUT_* when the Docker action env: passthrough
          # does not propagate them (observed with comma-separated values like FEATURED).
          : "''${FEATURED:=''${INPUT_FEATURED:-}}"
          : "''${FILTER:=''${INPUT_FILTER:-}}"
          : "''${BANNER:=''${INPUT_BANNER:-}}"
          : "''${THESIS:=''${INPUT_THESIS:-}}"
          export FEATURED FILTER BANNER THESIS
          # Use `bun run` instead of the compiled binary: bun 1.3.13's --compile output
          # prints help text and exits 0 without running the embedded script in this
          # container environment.
          ${pkgs.bun}/bin/bun run ${synopticRuntime}/synoptic.ts "$@"
          # Stage first, THEN check: `git diff --quiet` ignores untracked files, so a
          # brand-new output (e.g. a first STATUS.md) would read as "no change" and
          # never get committed. `git add -A` + `git diff --cached --quiet` catches
          # new, modified, and deleted files alike.
          ${pkgs.git}/bin/git add -A
          if ! ${pkgs.git}/bin/git diff --cached --quiet; then
            ${pkgs.git}/bin/git config user.name "github-actions[bot]"
            ${pkgs.git}/bin/git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
            # Wire credentials: actions/checkout sets up a helper on the runner but
            # that helper is not available inside the container. Use GITHUB_TOKEN directly.
            if [ -n "''${GITHUB_TOKEN:-}" ] && [ -n "''${GITHUB_REPOSITORY:-}" ]; then
              ${pkgs.git}/bin/git remote set-url origin \
                "https://x-access-token:''${GITHUB_TOKEN}@github.com/''${GITHUB_REPOSITORY}.git"
            fi
            ${pkgs.git}/bin/git commit -m "chore: refresh repositories (synoptic)"
            ${pkgs.git}/bin/git push
          else
            echo "no change"
          fi
        '';

        container = pkgs.dockerTools.buildLayeredImage {
          name = "ghcr.io/bdelanghe/synoptic-github";
          tag = "latest";
          contents = [ pkgs.bun synopticRuntime pkgs.git pkgs.cacert pkgs.bash pkgs.coreutils ];
          config = {
            Entrypoint = [ "${pkgs.bash}/bin/bash" "${entrypoint}" ];
            Env = [
              "SSL_CERT_FILE=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
              "GIT_SSL_CAINFO=${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt"
            ];
          };
        };
      in
      {
        packages = {
          default = synoptic;
          synoptic = synoptic;
          tools = tools;
          container = container;
        };

        devShells.default = pkgs.mkShell {
          packages = [ pkgs.bun pkgs.nodejs pkgs.git ];
        };
      }
    );
}
