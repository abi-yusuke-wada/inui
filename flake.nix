{
  description = "inuiの開発環境";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [
            pkgs.nodejs_24
            pkgs.pnpm
          ]
          # CLIのサンドボックス実行に必要（Linux・WSLのみ）
          ++ pkgs.lib.optionals pkgs.stdenv.isLinux [
            pkgs.bubblewrap
            pkgs.socat
          ];
        };
      });
    };
}
