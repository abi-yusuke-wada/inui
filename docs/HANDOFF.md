# 作業の引き継ぎ

CLIを切り替えるときに、最新の引き継ぎ1件へ更新する。共通ルールは [AGENTS.md](../AGENTS.md)、仕様は [MVP.md](../MVP.md)、設計判断は既存のADRを参照する。

## 対象・状態

- 対象: 開発支援ツール間でのコンテキスト共有、Issue #2の技術構成の検討、Issue #3の開発環境構築。
- ブランチ: `docs/issue-2-technical-plan`。作業場所は既存のリポジトリルートを使う。
- 変更: ADR-0001に技術構成・費用比較・採用理由・未確定事項を整理し、README・MVPから参照する。共有ルール・設定・個人設定のGit除外とCodeRabbitの日本語設定を整備した。Nix Flakes + direnvの開発環境（Node.js 24、pnpm、bubblewrap・socat）を追加し、[ADR-0002](adr/0002-development-environment.md) に記録した。
- 方針: 進行中の作業は現在のブランチ・作業ディレクトリで継続し、別worktreeは明示的な依頼がある場合のみ作成する。
- 状態: 初期整備と技術構成の文書化は完了。現在のブランチからmain向けPRでレビューする。HTTP入口の採用は未確定のため、Issue #2は継続する。

## 検証結果

- `git diff --check`、JSON・YAML構文、文書の相対リンク・文字コード・改行、個人設定のGit除外、共有ファイルの参照先を確認し、すべて成功した。料金表の計算とmainとの祖先関係も確認済み。
- devShellでNode.js 24.22.1・pnpm 11.27.0・bwrap・socatが使え、`make check`・`make sandbox-check` が成功した。
- 読み取り拒否: コミット `8c0f1e0` 時点の設定で、WSL2上のdevShell内からCLIを起動し、ダミーの `.env` がReadツールとサンドボックス内のBash（`cat .env`）の両方で拒否されることを確認した。実際の認証情報は使用していない。
- アプリ・基盤は未実装。会社側設定との組み合わせ、料金・接続の実測は未検証。

## 未完了事項・次の作業

- CLIを切り替える際は、このメモに加えて現在のブランチ・`git status`・差分を確認する。各CLIの会話履歴は自動同期しない。
- HTTP入口の採用は未確定。[ADR-0001](adr/0001-mvp-hosting-and-storage.md) と [Issue #2](https://github.com/abi-yusuke-wada/inui/issues/2) を確認して検討を続ける。
- ホーム配下の `.env`（`~/**/.env`）の読み取り拒否は設定済みで、実動作は未確認。
- アプリや基盤の構築は今回の対象外。
