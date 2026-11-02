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
          # CLIのサンドボックスは起動時に存在しないディレクトリを拒否できないため、
          # 拒否対象の .aws を作業領域とホームに事前に用意する（既存の権限は変更しない）
          shellHook = ''
            # 作成できない場合は拒否対象がないまま起動しないよう、開発環境の起動を止める
            for dir in "$(git rev-parse --show-toplevel 2>/dev/null || pwd)/.aws" "$HOME/.aws"; do
              if [ ! -d "$dir" ] && ! mkdir -m 700 "$dir"; then
                echo "$dir を作成できないため、開発環境を起動しません" >&2
                exit 1
              fi
            done
          '';
        };
      });
    };
}
