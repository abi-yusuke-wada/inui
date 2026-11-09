"""既存依存で固定revisionを準備し、同じモデル名のカードへ登録する。"""

import argparse
import importlib.metadata
import json
from pathlib import Path
import sys
import tempfile

MODEL = "nli-deberta-large"
REPO = "MoritzLaurer/deberta-v3-large-zeroshot-v2.0"
REVISION = "cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2"
FILES = (
    "config.json",
    "model.safetensors",
    "added_tokens.json",
    "special_tokens_map.json",
    "spm.model",
    "tokenizer.json",
    "tokenizer_config.json",
)


def prepare_model(*, offline: bool) -> None:
    """固定snapshotを確認し、組込みカードのhf_modelだけを置き換える。"""
    from huggingface_hub import snapshot_download

    root = Path(__file__).resolve().parent.parent
    distribution = importlib.metadata.distribution("local-jev")
    builtin_path = distribution.locate_file(f"local_jev/cards/{MODEL}.json")
    card = json.loads(builtin_path.read_text(encoding="utf-8"))
    if not isinstance(card, dict) or card.get("name") != MODEL or card.get("hf_model") != REPO:
        raise ValueError("builtin_card")
    snapshot = Path(snapshot_download(
        repo_id=REPO,
        revision=REVISION,
        cache_dir=root / ".local-jev" / "cache" / "hub",
        token=False,
        endpoint="https://huggingface.co",
        allow_patterns=list(FILES),
        local_files_only=offline,
    )).resolve()
    if snapshot.name != REVISION or not all((snapshot / name).is_file() for name in FILES):
        raise ValueError("snapshot_files")
    card["hf_model"] = str(snapshot)
    output = root / ".local-jev" / "models" / "cards" / f"{MODEL}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    # 読み込み途中のカードを推論サーバーに見せないよう、一括で置き換える。
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", encoding="utf-8", dir=output.parent,
            prefix=f".{MODEL}-", suffix=".tmp", delete=False,
        ) as stream:
            temporary = Path(stream.name)
            stream.write(json.dumps(card, ensure_ascii=False, indent=2) + "\n")
        temporary.replace(output)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def main() -> int:
    """引数を検証し、失敗時は例外の種別だけを表示する。"""
    try:
        parser = argparse.ArgumentParser(allow_abbrev=False, exit_on_error=False)
        parser.add_argument("--offline", action="store_true", help="取得せず既存キャッシュだけを使う")
        args, unknown = parser.parse_known_args()
        if unknown:
            raise ValueError("arguments")
        prepare_model(offline=args.offline)
    except Exception as error:
        print(f"jev-local-pin-model: error ({type(error).__name__})", file=sys.stderr)
        return 1
    print("jev-local-pin-model: OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
