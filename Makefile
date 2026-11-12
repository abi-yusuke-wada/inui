# 開発で使うコマンドの入口。ビルド・実行・テスト等のコマンドはここにターゲットとして追加する。
# devShell（direnvまたは `nix develop`）に入った状態で実行する。

.DEFAULT_GOAL := help
.PHONY: app-setup app-setup-offline app-lock app-build app-check app-ui-check app-replay-check app-model-check app-probe app-diagnose app-web-diagnose app-dev app-smoke core-check app-run app-reset lint lint-workflows ci

# 公開npmパッケージだけを取得し、利用者の認証設定は参照しない。
INUI_PNPM := env -i PATH="$(PATH)" XDG_CONFIG_HOME="$(CURDIR)/.local-poc/config" XDG_CACHE_HOME="$(CURDIR)/.local-poc/cache" XDG_STATE_HOME="$(CURDIR)/.local-poc/state" pnpm --config.userconfig=/dev/null --config.globalconfig=/dev/null --config.store-dir="$(CURDIR)/.local-poc/pnpm-store" --config.verify-deps-before-run=error
BIOME_FLAGS ?= --error-on-warnings

app-setup: ## ローカルPoCの公開npm依存を取得する（ネットワーク使用・インストールscript無効）
	@mkdir -p .local-poc/config .local-poc/cache .local-poc/state .local-poc/pnpm-store
	@chmod 700 .local-poc
	@$(INUI_PNPM) install --frozen-lockfile --ignore-scripts --fetch-retries=0 --fetch-timeout=10000

app-setup-offline: ## 取得済み依存だけでworkspaceのリンクを更新する（通信なし）
	@$(INUI_PNPM) install --offline --frozen-lockfile --ignore-scripts

app-lock: ## 変更した依存定義を取得済みキャッシュからlockへ反映する（通信なし）
	@$(INUI_PNPM) install --offline --lockfile-only --ignore-scripts

lint: lint-workflows ## TypeScript・React・CSSとGitHub Actionsの定義を検査する
	biome --version
	biome lint $(BIOME_FLAGS) src tests packages/core/src packages/core/tests scripts

lint-workflows: ## GitHub Actionsの定義を検査する
	actionlint .github/workflows/ci.yml

ci: lint app-check jev-check ## lint・型検査・ビルド・全オフラインテストを実行する（実モデル不要）

core-check: ## 独立コアを外部通信なしで検証する
	node --test --test-isolation=none packages/core/tests/*.test.ts

app-build: ## 独立コアとローカルPoCをビルドする
	node_modules/.bin/tsc -p packages/core/tsconfig.build.json
	node_modules/.bin/esbuild src/server.ts --bundle --platform=node --packages=external --format=esm --target=node24 --outfile=dist/server.js
	node_modules/.bin/esbuild src/web/main.tsx --bundle --format=esm --target=es2022 --jsx=automatic --minify --define:process.env.NODE_ENV='"production"' --outfile=dist/public/app.js
	cp src/web/index.html dist/public/index.html

app-ui-check: app-build ## DOM上でフォーム保存・人名選択・従来UIの操作を検証する
	node_modules/.bin/esbuild tests/web/App.test.tsx --bundle --packages=external --platform=node --format=esm --target=node24 --jsx=automatic --outfile=dist/ui-tests/App.test.js
	node --test --test-isolation=none dist/ui-tests/App.test.js
	node --test --test-isolation=none tests/scripts/poc-web.test.mjs

app-replay-check: ## 保存した19件の実NLI応答と現コアを再照合する（推論・通信なし）
	@mkdir -p -m 700 .local-poc
	@node scripts/poc-probe.mjs --replay docs/poc-nli-responses-2026-11-10.jsonl > .local-poc/replay-verification.json
	@node -p 'JSON.stringify(JSON.parse(require("node:fs").readFileSync(".local-poc/replay-verification.json", "utf8")).summary)'

app-check: app-ui-check app-replay-check ## コア・API・永続化・UIのテストと型・差分を検証する
	node_modules/.bin/tsc -p packages/core/tsconfig.json
	node_modules/.bin/tsc -p tsconfig.json
	node --test --test-isolation=none packages/core/tests/*.test.ts tests/*.test.ts tests/web/*.test.ts tests/scripts/poc-probe.test.mjs tests/scripts/poc-local.test.mjs
	git diff --check

app-model-check: ## キャッシュ済み実NLIの7候補を19入力で検証する（外部通信なし）
	@mkdir -p -m 700 .local-poc
	@env -u TYPESAFE_API_KEY -u HF_TOKEN HF_HOME="$$(pwd)/.local-jev/cache" LOCAL_JEV_MODELS="$$(pwd)/.local-jev/models" HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 .local-jev/venv/bin/python -u scripts/poc-model-check.py > .local-poc/model-responses.jsonl
	@node scripts/poc-probe.mjs --replay .local-poc/model-responses.jsonl > .local-poc/model-verification.json
	@node -p 'JSON.stringify(JSON.parse(require("node:fs").readFileSync(".local-poc/model-verification.json", "utf8")).summary)'

app-probe: ## 起動中のPoCと実NLIを19入力でHTTP検証する（申請の保存はしない）
	@mkdir -p -m 700 .local-poc
	@node scripts/poc-probe.mjs > .local-poc/http-verification.json
	@node -p 'JSON.stringify(JSON.parse(require("node:fs").readFileSync(".local-poc/http-verification.json", "utf8")).summary)'

app-diagnose: ## アプリと推論サーバーの接続を個別に確認する（保存なし）
	@mkdir -p -m 700 .local-poc
	@node scripts/poc-probe.mjs --diagnose > .local-poc/connection-check.json

app-web-diagnose: ## HTML・JS・CSSの受信完了とビルドとの一致を確認する（推論なし）
	@mkdir -p -m 700 .local-poc
	@node scripts/poc-probe.mjs --web-diagnose > .local-poc/web-check.json

app-dev: app-build ## アプリと実NLIをまとめて起動する
	node scripts/poc-local.mjs --dev

app-smoke: app-build ## アプリと実NLIを起動して19入力を検証する
	node scripts/poc-local.mjs --smoke

app-run: app-build ## アプリだけを127.0.0.1:8766で起動する（実NLIは別途起動）
	node dist/server.js

app-reset: ## ローカルPoCの検証データだけを初期2件へ戻す
	node src/reset.ts
.PHONY: help check sandbox-check jev-check jev-probe jev-probe-dry-run jev-probe-live jev-probe-local jev-prompt-study jev-local-setup jev-local-versions jev-local-pin-model jev-local-serve

LOCAL_JEV_REV := 64a0b31ff343dca32142496cf9edca5a0174a18d
LOCAL_JEV_ARCHIVE := https://github.com/amithgc/local-jev/archive/$(LOCAL_JEV_REV).tar.gz

help: ## ターゲット一覧を表示する
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*## "}; {printf "  %-14s %s\n", $$1, $$2}'

check: ## 開発環境の定義と差分の空白を検証する
	nix flake check
	git diff --check HEAD

jev-check: ## JEV接続プローブを実APIなしで検証する
	@# 単一ファイルの各ケースを同一プロセスで実行し、子プロセス起動に依存しない。
	node --test --test-isolation=none tests/scripts/jev-probe.test.mjs
	git diff --check HEAD

jev-probe: ## APIキーありは公式Jev、なしはローカルNLIで13入力を検証する
	node scripts/jev-probe.mjs --auto

jev-probe-dry-run: ## MVPの13入力とJEVリクエストを表示する（通信なし）
	node scripts/jev-probe.mjs --dry-run

jev-probe-live: ## JEVへ最大13回接続する（APIキー・通信許可・利用料金の確認が必要）
	node scripts/jev-probe.mjs --live

jev-probe-local: ## ローカルNLIへ最大13回接続してIntentを検証する
	node scripts/jev-probe.mjs --local

jev-prompt-study: ## キャッシュ済みの既定NLIで候補説明を比較する（外部通信なし）
	@env -u TYPESAFE_API_KEY -u HF_TOKEN HF_HOME="$$(pwd)/.local-jev/cache" LOCAL_JEV_MODELS="$$(pwd)/.local-jev/models" HF_HUB_DISABLE_IMPLICIT_TOKEN=1 HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 PYTHONDONTWRITEBYTECODE=1 OMP_NUM_THREADS=4 MKL_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 .local-jev/venv/bin/python -u scripts/jev-prompt-study.py

jev-local-setup: ## local-jevとCPU用Python依存を取得する（ネットワーク使用）
	@# 外部へのPython symlinkを作らず、既存のvenvは再作成しない。
	@test -x ".local-jev/venv/bin/python" || python3.12 -m venv --copies --without-pip ".local-jev/venv"
	uv --no-config --cache-dir ".local-jev/uv-cache" pip install --python ".local-jev/venv/bin/python" --index-url https://download.pytorch.org/whl/cpu 'torch>=2.4'
	uv --no-config --cache-dir ".local-jev/uv-cache" pip install --python ".local-jev/venv/bin/python" "$(LOCAL_JEV_ARCHIVE)"

jev-local-versions: ## 導入済みruntimeのバージョンを表示する（通信なし）
	@test -x ".local-jev/venv/bin/python" || { echo "先に make jev-local-setup を実行してください" >&2; exit 1; }
	@.local-jev/venv/bin/python -B -c 'import importlib.metadata as m, json; print(json.dumps({name: m.version(name) for name in ("local-jev", "torch", "transformers", "huggingface-hub")}))'

jev-local-pin-model: ## 実測revisionの重みとtokenizerを取得し、ローカルカードへ固定する（通信あり）
	@test -x ".local-jev/venv/bin/python" || { echo "先に make jev-local-setup を実行してください" >&2; exit 1; }
	@env -u TYPESAFE_API_KEY -u HF_TOKEN HF_HUB_DISABLE_IMPLICIT_TOKEN=1 .local-jev/venv/bin/python -B scripts/jev-local-pin-model.py

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
