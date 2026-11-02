# 開発で使うコマンドの入口。ビルド・実行・テスト等のコマンドはここにターゲットとして追加する。
# devShell（direnvまたは `nix develop`）に入った状態で実行する。

.DEFAULT_GOAL := help
.PHONY: help check sandbox-check

help: ## ターゲット一覧を表示する
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'

check: ## 開発環境の定義と差分の空白を検証する
	nix flake check
	git diff --check HEAD

sandbox-check: ## CLIのサンドボックスに必要なツールとユーザー名前空間を確認する
	command -v bwrap
	command -v socat
	@sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo "AppArmorによるユーザー名前空間の制限設定なし"
	bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all true
	@test -d "$$HOME/.aws" || { echo "~/.aws がありません。direnvで開発環境に入り直してください"; exit 1; }
	@# 作業領域外を指すシンボリックリンクは、リンク先の .env を拒否できないため検出する
	@links=$$(find . \( -path ./.git -o -path ./.direnv -o -path '*/node_modules' \) -prune -o -type l -print | \
		while read -r l; do t=$$(readlink -f "$$l"); case "$$t" in "$$PWD"/*) ;; *) echo "  $$l -> $$t";; esac; done); \
		if [ -n "$$links" ]; then echo "作業領域外を指すシンボリックリンクがあります:"; echo "$$links"; exit 1; fi
	@echo "サンドボックスの前提条件を満たしています"
