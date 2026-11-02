# 開発で使うコマンドの入口。ビルド・実行・テスト等のコマンドはここにターゲットとして追加する。
# devShell（direnvまたは `nix develop`）に入った状態で実行する。

.DEFAULT_GOAL := help
.PHONY: help check sandbox-check

help: ## ターゲット一覧を表示する
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'

check: ## 開発環境の定義と差分の空白を検証する
	nix flake check
	git diff --check

sandbox-check: ## CLIのサンドボックスに必要なツールとユーザー名前空間を確認する
	command -v bwrap
	command -v socat
	@sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo "AppArmorによるユーザー名前空間の制限設定なし"
	bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all true
	@echo "サンドボックスの前提条件を満たしています"
