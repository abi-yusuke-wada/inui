# 開発で使うコマンドの入口。ビルド・実行・テスト等のコマンドはここにターゲットとして追加する。
# devShell（direnvまたは `nix develop`）に入った状態で実行する。

.DEFAULT_GOAL := help
.PHONY: help check sandbox-check jev-check jev-probe jev-probe-dry-run jev-probe-live jev-probe-local jev-local-setup jev-local-serve

LOCAL_JEV_REV := 64a0b31ff343dca32142496cf9edca5a0174a18d
LOCAL_JEV_ARCHIVE := https://github.com/amithgc/local-jev/archive/$(LOCAL_JEV_REV).tar.gz

help: ## ターゲット一覧を表示する
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'

check: ## 開発環境の定義と差分の空白を検証する
	nix flake check
	git diff --check HEAD

jev-check: ## JEV接続プローブを実APIなしで検証する
	@# 単一ファイルの各ケースを同一プロセスで実行し、子プロセス起動に依存しない。
	node --test --test-isolation=none scripts/jev-probe.test.mjs
	git diff --check HEAD

jev-probe: ## APIキーありは公式Jev、なしはローカルNLIで13入力を検証する
	node scripts/jev-probe.mjs --auto

jev-probe-dry-run: ## MVPの13入力とJEVリクエストを表示する（通信なし）
	node scripts/jev-probe.mjs --dry-run

jev-probe-live: ## JEVへ最大13回接続する（APIキー・通信許可・利用料金の確認が必要）
	node scripts/jev-probe.mjs --live

jev-probe-local: ## ローカルNLIへ最大13回接続してIntentを検証する
	node scripts/jev-probe.mjs --local

jev-local-setup: ## local-jevとCPU用Python依存を取得する（ネットワーク使用）
	@# 外部へのPython symlinkを作らず、既存のvenvは再作成しない。
	@test -x ".local-jev/venv/bin/python" || python3.12 -m venv --copies --without-pip ".local-jev/venv"
	uv --no-config --cache-dir ".local-jev/uv-cache" pip install --python ".local-jev/venv/bin/python" --index-url https://download.pytorch.org/whl/cpu 'torch>=2.4'
	uv --no-config --cache-dir ".local-jev/uv-cache" pip install --python ".local-jev/venv/bin/python" "$(LOCAL_JEV_ARCHIVE)"

jev-local-serve: ## ローカルNLIを起動する（初回は選んだモデルを取得）
	@set -eu; \
	local_jev_model="$${LOCAL_JEV_MODEL:-nli-deberta-large}"; \
	case "$$local_jev_model" in \
		nli-deberta-large|nli-multilingual-minilm) ;; \
		*) echo "LOCAL_JEV_MODELは nli-deberta-large または nli-multilingual-minilm を指定してください" >&2; exit 1 ;; \
	esac; \
	test -x ".local-jev/venv/bin/local-jev" || { echo "先に make jev-local-setup を実行してください" >&2; exit 1; }; \
	mkdir -p ".local-jev/models/cards"; \
	cp "scripts/jev-local-multilingual.json" ".local-jev/models/cards/nli-multilingual-minilm.json"; \
	exec env -u TYPESAFE_API_KEY HF_HOME="$$(pwd)/.local-jev/cache" HF_HUB_DISABLE_IMPLICIT_TOKEN=1 LOCAL_JEV_MODELS="$$(pwd)/.local-jev/models" .local-jev/venv/bin/local-jev serve --model "$$local_jev_model" --host 127.0.0.1 --port 8765

sandbox-check: ## CLIのサンドボックスに必要なツールとユーザー名前空間を確認する
	command -v bwrap
	command -v socat
	@sysctl kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo "AppArmorによるユーザー名前空間の制限設定なし"
	bwrap --ro-bind / / --dev /dev --proc /proc --unshare-all true
	@test -d .aws && test -d "$$HOME/.aws" || { echo ".aws または ~/.aws がありません。開発環境（direnvまたは nix develop）に入り直してください"; exit 1; }
	@# 作業領域外を指すシンボリックリンクは、リンク先の .env を拒否できないため検出する
	@# リンク名は改行を含み得るため、行で分割せず -exec で1件ずつ判定する
	@links=$$(find . \( -path ./.git -o -path ./.direnv -o -path '*/node_modules' \) -prune -o -type l \
		-exec sh -c 'r=$$(pwd -P); for l; do t=$$(readlink -f "$$l"); case "$$t" in "$$r"|"$$r"/*) ;; *) printf "  %s -> %s\n" "$$l" "$$t";; esac; done' sh {} +) || \
		{ echo "シンボリックリンクの走査に失敗しました"; exit 1; }; \
		if [ -n "$$links" ]; then echo "作業領域外を指すシンボリックリンクがあります:"; echo "$$links"; exit 1; fi
	@echo "サンドボックスの前提条件を満たしています"
