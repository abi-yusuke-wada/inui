"""固定モデル・固定入力で候補説明を比較する。HTTPを介さず実NLIを呼ぶ。"""

import copy
import faulthandler
import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import torch
from huggingface_hub import try_to_load_from_cache
from local_jev.engine import Engine


MODEL = "nli-deberta-large"
DIRECT_CRITERIA = {
    "leave_request": "利用者は有給休暇や半日休暇などの休暇を申請したい。",
    "expense_request": "利用者は電車代などの交通費を経費として申請・精算したい。",
    "application_status": "利用者は提出した申請の一覧や状態を見たい。",
    "unsupported_feature": "利用者は出張手続きや施設予約など、休暇・交通費・申請状況以外の用件を扱いたい。",
    "unsupported_operation": "利用者は申請の取り下げ・修正・承認・差し戻しのいずれかを実行したい。",
    "clarify": "利用者は申請したいが、休暇や経費などの種類を指定していない。",
}

# CASESを検証プローブから取得し、期待値を複製・変更しない。
source = subprocess.run(
    ["node", "--input-type=module", "-e", """
import { CASES, LOCAL_MODEL, buildRequest } from './scripts/jev-probe.mjs';
console.log(JSON.stringify(CASES.map(sample => ({
  ...sample, request: buildRequest(sample.text, { model: LOCAL_MODEL }),
}))));
"""],
    check=True,
    capture_output=True,
    text=True,
)
cases = json.loads(source.stdout)
normal_intents = {"leave_request", "expense_request", "application_status"}
if (len(cases) != 13 or len({sample["id"] for sample in cases}) != 13
        or sum(sample["expected"] in normal_intents for sample in cases) != 9
        or any(sample["request"]["model"] != MODEL for sample in cases)):
    raise SystemExit("固定13入力・正常9件・基準モデルの前提に一致しません。")
# 比較前の質問を固定し、プローブへの採用後も同じ対照条件を再現する。
baseline = {
    "type": "choice",
    "instructions": "入力の利用者が何を求めているかを、候補の説明に従って分類してください。",
    "criteria": {
        "leave_request": "休暇・有給・半休の申請フォームを開く要求。",
        "expense_request": "交通費の経費精算フォームを開く要求。",
        "application_status": "自分が提出した申請の一覧や状態を確認する要求。状態による絞り込みも含む。",
        "unsupported_feature": "休暇申請・交通費精算・申請状況の確認以外の機能や申請書を求めている。",
        "unsupported_operation": "申請の取り下げ・修正・承認・差し戻しなど、今回扱わない操作を求めている。",
        "clarify": "申請の種類や目的が不明で、対象の画面を特定できない。再入力が必要。",
    },
}
direct = {**baseline, "criteria": DIRECT_CRITERIA}
profiles = {
    "baseline": baseline,
    "direct-descriptions": direct,
    "direct-short-question": {**direct, "instructions": ""},
}
status_criteria = {
    **DIRECT_CRITERIA,
    "application_status": "利用者は提出済み申請の承認待ち・承認済み・差し戻しなどの状態を確認したい。",
}
boundary_criteria = {
    **status_criteria,
    "unsupported_operation": "利用者は申請を取り下げる、内容を変更する、または承認者の作業を実行したい。",
    "clarify": "利用者は種類を指定せずに何かの申請をしたい。",
}
profiles.update({
    "direct-status-specific": {**baseline, "criteria": status_criteria},
    "direct-boundaries": {**baseline, "criteria": boundary_criteria},
    "direct-generic-request": {
        **baseline,
        "criteria": {**boundary_criteria, "clarify": "利用者は何かを申請したい。"},
    },
})
for name, description in {
    "clarify-incomplete-ja": "利用者は申請手続きを始めたいとだけ述べており、具体的な申請の用件は示していない。",
    "clarify-incomplete-en": "The user expresses only a general wish to apply, without identifying the kind of application.",
    "clarify-missing-type": "申請の種類が不明で、内容の確認が必要である。",
}.items():
    profiles[name] = {**baseline, "criteria": {**boundary_criteria, "clarify": description}}
intent_aliases = {}
for alias in ["unspecified_application", "unclear_application"]:
    name = f"clarify-key-{alias}"
    criteria = dict(profiles["clarify-incomplete-ja"]["criteria"])
    description = criteria.pop("clarify")
    criteria[alias] = description
    profiles[name] = {**baseline, "criteria": criteria}
    intent_aliases[name] = {alias: "clarify"}
for name, description in {
    "feature-outside-supported": "利用者は出張申請や会議室予約など、休暇申請・交通費精算・申請状況の確認以外のサービスを利用したい。",
    "feature-not-available": "利用者は出張の申請や会議室の予約など、このアプリが扱わない機能を使いたい。",
}.items():
    profiles[name] = {
        **baseline,
        "criteria": {**profiles["clarify-key-unspecified_application"]["criteria"], "unsupported_feature": description},
    }
    intent_aliases[name] = {"unspecified_application": "clarify"}
selected = os.environ.get(
    "JEV_PROMPT_PROFILES", "baseline,feature-outside-supported"
).split(",")
if not selected or any(name not in profiles for name in selected):
    raise SystemExit("JEV_PROMPT_PROFILESには比較対象の固定プロファイル名を指定してください。")

torch.set_num_threads(4)
torch.set_num_interop_threads(1)
metadata = {
    "model": MODEL,
    "transport": "in-process-local-jev-engine",
    "torch_threads": torch.get_num_threads(),
    "warmup": False,
    "runtime": {
        name: importlib.metadata.version(name)
        for name in ["local-jev", "torch", "transformers"]
    },
}
print(json.dumps({"status": "loading", **metadata}, ensure_ascii=False), file=sys.stderr, flush=True)
started = time.perf_counter()
engine = Engine(default=MODEL, warmup=False)
faulthandler.dump_traceback_later(45)
try:
    backend = engine.backend(MODEL)
finally:
    faulthandler.cancel_dump_traceback_later()
metadata["device"] = backend.device
metadata["dtype"] = str(backend.model.dtype)
metadata["hf_model"] = engine.models[MODEL].options["hf_model"]
cached_config = try_to_load_from_cache(metadata["hf_model"], "config.json")
metadata["hf_revision"] = Path(cached_config).parent.name if isinstance(cached_config, str) else None
metadata["temperature"] = engine.models[MODEL].temperature
metadata["model_load_ms"] = round((time.perf_counter() - started) * 1000)
print(json.dumps({"status": "loaded", **metadata}, ensure_ascii=False), file=sys.stderr, flush=True)

criterion_met = False
for name in selected:
    question = profiles[name]
    aliases = intent_aliases.get(name, {})
    results = []
    for sample in cases:
        request = copy.deepcopy(sample["request"])
        request["questions"]["intent"] = question
        started = time.perf_counter()
        response = engine.system_one(**request)
        answer = response["answers"]["intent"]
        actual = aliases.get(answer["choice"], answer["choice"])
        probabilities = {aliases.get(key, key): value for key, value in answer["probabilities"].items()}
        if set(probabilities) != set(DIRECT_CRITERIA):
            raise RuntimeError("応答の候補と固定Intentの対応が一致しません。")
        results.append({
            "case_id": sample["id"], "text": sample["text"],
            "provider": "local-jev",
            "expected": sample["expected"], "actual": actual,
            "wire_choice": answer["choice"], "matched": actual == sample["expected"],
            "model": response["model"], "confidence": answer["confidence"],
            "probabilities": probabilities, "usage": response["usage"],
            "elapsed_ms": round((time.perf_counter() - started) * 1000),
        })
        print(f"{name}: {sample['id']} -> {actual}", file=sys.stderr, flush=True)
    record = {
        "profile": name, "metadata": metadata, "question": question, "intent_aliases": aliases,
        "summary": {
            "matched": sum(row["matched"] for row in results), "total": len(results),
            "normal_matched": sum(row["matched"] for row in results if row["expected"] in normal_intents),
            "abnormal_matched": sum(row["matched"] for row in results if row["expected"] not in normal_intents),
        },
        "results": results,
    }
    record["summary"]["criterion_met"] = all(row["matched"] for row in results)
    criterion_met |= record["summary"]["criterion_met"]
    print(json.dumps(record, ensure_ascii=False), flush=True)

sys.exit(0 if criterion_met else 1)
