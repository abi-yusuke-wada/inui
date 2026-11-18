"""現コアの19入力を固定revisionの実NLIで評価する。HTTP経路は実行しない。"""

import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import resource
import subprocess
import sys
import time


MODEL = "nli-deberta-large"
REPOSITORY = "MoritzLaurer/deberta-v3-large-zeroshot-v2.0"
REVISION = "cf44676c28ba7312e5c5f8f8d2c22b3e0c9cdae2"
ROOT = Path(__file__).resolve().parent.parent
FILES = (
    "config.json", "model.safetensors", "added_tokens.json", "special_tokens_map.json",
    "spm.model", "tokenizer.json", "tokenizer_config.json",
)


def source_requests():
    """shellを使わずNodeから現行の入力・期待値・質問を取得する。"""
    source = subprocess.run(
        ["node", str(ROOT / "scripts" / "poc-probe.mjs"), "--requests"],
        cwd=ROOT, check=True, capture_output=True, text=True, timeout=30,
    )
    samples = json.loads(source.stdout)
    screens = {"leave_request", "expense_request", "application_status", "schedule_compare"}
    if (not isinstance(samples, list) or len(samples) != 19
            or len({sample["id"] for sample in samples}) != 19
            or sum(sample["expected"] in screens for sample in samples) != 13
            or sum(sample["expectedPeople"] is not None for sample in samples) != 4
            or any(sample["request"]["model"] != MODEL
                   or sample["request"]["state"] != sample["text"]
                   or set(sample["request"]["questions"]) != {"intent"}
                   or len(sample["request"]["questions"]["intent"]["criteria"]) != 7
                   for sample in samples)):
        raise ValueError("fixed_cases")
    return samples, hashlib.sha256(source.stdout.strip().encode("utf-8")).hexdigest()


def run():
    """オフライン条件と重みの版を先に確認し、実Engineの結果をJSONLで記録する。"""
    if len(sys.argv) != 1 or any(os.environ.get(name) != "1" for name in (
        "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE", "HF_HUB_DISABLE_IMPLICIT_TOKEN",
    )):
        raise ValueError("offline_configuration")
    samples, digest = source_requests()

    import torch
    from huggingface_hub import try_to_load_from_cache
    from local_jev.engine import Engine
    from local_jev.schema import SystemOneResponse

    torch.set_num_threads(4)
    torch.set_num_interop_threads(1)
    metadata = {
        "model": MODEL, "transport": "in-process-local-jev-engine",
        "response_conversion": "SystemOneResponse.model_validate(raw).model_dump()",
        "http_route_executed": False,
        "torch_threads": torch.get_num_threads(), "torch_interop_threads": torch.get_num_interop_threads(),
        "warmup": False,
        "runtime": {name: importlib.metadata.version(name) for name in ("local-jev", "torch", "transformers")},
        "requests_sha256": digest, "case_count": len(samples),
    }
    print("poc-model-check: loading fixed local model", file=sys.stderr, flush=True)
    started = time.perf_counter()
    engine = Engine(default=MODEL, warmup=False)
    card = engine.models[MODEL]
    configured = card.options["hf_model"]
    if configured == REPOSITORY:
        cached = try_to_load_from_cache(REPOSITORY, "config.json", revision=REVISION)
        if not isinstance(cached, str):
            raise ValueError("missing_fixed_snapshot")
        snapshot = Path(cached).parent
    else:
        snapshot = Path(configured)
    # snapshot配下のファイルはblobへのsymlinkなので、ディレクトリ名でrevisionを確認する。
    if (not snapshot.is_absolute() or snapshot.name != REVISION or snapshot.parent.name != "snapshots"
            or snapshot.parent.parent.name != "models--MoritzLaurer--deberta-v3-large-zeroshot-v2.0"
            or not all((snapshot / name).is_file() for name in FILES)):
        raise ValueError("fixed_revision")
    # 同じモデルの同じsnapshotを読み込ませる。候補・期待値・較正値は変更しない。
    card.options["hf_model"] = str(snapshot)
    card.options["device"] = "cpu"
    backend = engine.backend(MODEL)
    metadata.update({
        "device": backend.device, "dtype": str(backend.model.dtype), "hf_model": str(snapshot),
        "hf_revision": snapshot.name, "temperature": card.temperature,
        "model_load_ms": round((time.perf_counter() - started) * 1000),
    })
    if metadata["device"] != "cpu" or metadata["dtype"] != "torch.float32":
        raise ValueError("runtime_configuration")
    records = []
    for index, sample in enumerate(samples, 1):
        started = time.perf_counter()
        raw = engine.system_one(**sample["request"])
        elapsed = round((time.perf_counter() - started) * 1000)
        truncated = raw.get("truncated")
        # HTTPと同じschema整形だけを行う。HTTPルートやTCPを実行した証拠にはしない。
        response = SystemOneResponse.model_validate(raw).model_dump()
        records.append({
            "type": "result", "sampleID": sample["id"], "rawResponse": response,
            "elapsed_ms": elapsed, "truncated": truncated,
        })
        print(f"poc-model-check: {index}/19 {sample['id']} completed", file=sys.stderr, flush=True)
        if truncated is not False:
            raise ValueError("truncated_or_unknown")
    # ru_maxrssはLinuxではKiB、Darwinではbytes。他OSでは値の単位を推測しない。
    metadata["peak_rss"] = {
        "value": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss,
        "unit": "KiB" if sys.platform.startswith("linux") else "bytes" if sys.platform == "darwin" else "platform-native",
        "platform": sys.platform,
        "scope": "Python process through 19 Engine calls; not a deployed Lambda measurement",
    }
    print(json.dumps({"type": "metadata", "metadata": metadata}, ensure_ascii=False, allow_nan=False), flush=True)
    for record in records:
        print(json.dumps(record, ensure_ascii=False, allow_nan=False), flush=True)
    # 分類の一致判定はNodeの--replayで行う。この終了0は実行完了のみを示す。
    return 0


def main():
    """例外本文や認証情報を記録せず、失敗は型だけをstderrへ出す。"""
    try:
        return run()
    except Exception as error:
        print(f"poc-model-check: failed ({type(error).__name__})", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
