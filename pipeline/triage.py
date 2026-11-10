"""Triage engine: two Gemini calls per question, then programmatic guards.

CALL A  independent solve (stored answer and solution are NEVER sent)
CALL B  triage decision per report (strict JSON, taxonomy-closed)

After the model returns, every decision passes deterministic guards:
  - verdict/repair exist in taxonomy.json
  - repair only when verdict == defect; field whitelist respected
  - auto:false repairs always route faculty_review
  - auto_apply only when auto:true AND confidence >= 0.85 AND edit verifies
  - edit.find is an exact substring of the raw source field content
Guard failures are quarantined to pipeline/quarantine.json, never silently fixed.

Usage:
  export GEMINI_API_KEY=...          # or pass --key-file (chmod 600 file)
  export GEMINI_MODEL=gemini-2.5-flash
  python3 pipeline/triage.py                  # run all questions
  python3 pipeline/triage.py --only R005 R009 # rerun specific reports
  python3 pipeline/triage.py --assemble       # merge run shards -> results.json

Runs are resumable: per-question shards land in pipeline/runs/<qid>.json and
are skipped on rerun unless --force.
"""
import argparse
import json
import os
import sys
import time
import urllib.request
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import load_all
from prompts import CALL_A_TEMPLATE, CALL_B_TEMPLATE

ROOT = Path(__file__).resolve().parent.parent
RUNS = ROOT / "pipeline" / "runs"
QUARANTINE = ROOT / "pipeline" / "quarantine.json"

AUTO_APPLY_MIN_CONFIDENCE = 0.85
NO_CHANGE_VERDICTS = {"no_error", "display_issue", "app_issue",
                      "language_mode", "not_actionable", "already_fixed"}
QTYPE_LABEL = {"scq": "single-correct MCQ", "mcq": "multiple-correct MCQ",
               "integerQuestion": "integer-answer (numerical)"}
ANSWER_SPEC = {
    "scq": "\"A\" | \"B\" | \"C\" | \"D\" (one letter)",
    "mcq": "[\"A\", \"C\"] (list of letters)",
    "integerQuestion": "the integer/number, as a string",
}


# ------------------------------------------------------------------ Gemini API

def gemini_call(prompt, key, model, tries=4, fallbacks=()):
    """One generateContent call with retries, then fallback models."""
    models = [model, *fallbacks]
    last = None
    for mi, m in enumerate(models):
        try:
            return _gemini_call_model(prompt, key, m, 2 if mi == 0 else 2), m
        except RuntimeError as e:
            last = e
            print(f"  model {m} failed ({e}); "
                  f"{'trying fallback' if mi + 1 < len(models) else 'no fallbacks left'}")
    raise last


def _gemini_call_model(prompt, key, model, tries):
    url = (f"https://generativelanguage.googleapis.com/v1beta/models/"
           f"{model}:generateContent")
    body = json.dumps({
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"responseMimeType": "application/json",
                             "temperature": 0.2},
    }).encode()
    last = None
    for attempt in range(tries):
        req = urllib.request.Request(url, data=body, method="POST", headers={
            "Content-Type": "application/json", "x-goog-api-key": key})
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = json.load(resp)
            return data["candidates"][0]["content"]["parts"][0]["text"]
        except urllib.error.HTTPError as e:
            body = e.read()
            last = f"HTTP {e.code}: {body[:200]!r}"
            if e.code in (429, 500, 503):
                wait = min(60, 5 * 2 ** attempt)
                try:  # honor the server's own Retry-After when present
                    details = json.loads(body)["error"]["details"]
                    for d in details:
                        if d.get("@type", "").endswith("RetryInfo"):
                            wait = max(wait, min(90, float(
                                d["retryDelay"].rstrip("s"))))
                except Exception:
                    pass
                time.sleep(wait)
                continue
            raise RuntimeError(last)
        except (urllib.error.URLError, TimeoutError, KeyError, IndexError) as e:
            last = repr(e)
            time.sleep(min(60, 5 * 2 ** attempt))
    raise RuntimeError(f"gemini_call failed after {tries} tries: {last}")


def parse_json(text):
    text = text.strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0]
    return json.loads(text)


# --------------------------------------------------------------- prompt build

def fmt_options(options):
    if not options:
        return "(no options parsed - integer-answer question)"
    return "\n".join(f"({o['label']}) {o['text'] or '[BLANK]'}"
                     for o in options)


def build_call_a(view):
    return CALL_A_TEMPLATE.format(
        subject=view["subject"], qtype=view["type"],
        qtype_label=QTYPE_LABEL[view["type"]],
        options_note=("There may be missing or blank options; note them in "
                      "\"issues\" if so." if view["type"] != "integerQuestion"
                      else "Answer with a number."),
        stem=view["stem"], options_block=fmt_options(view["options"]),
        answer_spec=ANSWER_SPEC[view["type"]])


def build_call_b(view, solve, reports, taxonomy):
    verdicts = "\n".join(f"  {k}: {v}" for k, v in taxonomy["verdicts"].items())
    repairs = "\n".join(
        f"  {k}: fields={v['fields']} auto={v['auto']} - {v['label']}"
        for k, v in taxonomy["repairs"].items())
    auto_false = ", ".join(k for k, v in taxonomy["repairs"].items()
                           if not v["auto"])
    reports_block = "\n".join(
        f"  {r['reportId']} ({r['source']}, {r['reportedAt']}): {r['comment']}"
        for r in reports)
    malformed = (f"NOTE: stored answer field is malformed: "
                 f"{view['answer_malformed_note']}"
                 if view["answer_malformed_note"] else "")
    return CALL_B_TEMPLATE.format(
        qtype=view["type"], subject=view["subject"], chapter=view["chapter"],
        stem=view["stem"], options_block=fmt_options(view["options"]),
        stored_answer=json.dumps(view.get("stored_answer_raw",
                                          view["stored_answer"])),
        malformed_note=malformed, solution_text=view["solution_text"],
        independent_solve=json.dumps(solve, indent=1),
        reports_block=reports_block, verdicts=verdicts, repairs=repairs,
        auto_false=auto_false)


# --------------------------------------------------------------------- guards

def source_field(view, field):
    if field == "question":
        return view["stem"] + "\n" + fmt_options(view["options"])
    if field == "solution":
        return view["solution_text"]
    if field == "answer":
        ans = view.get("stored_answer_raw", view["stored_answer"])
        return json.dumps(ans) if isinstance(ans, list) else str(ans)
    return None


def guard(decision, view, taxonomy):
    """Return list of violations (empty = clean). Never mutates."""
    v = []
    verdict = decision.get("verdict")
    repair = decision.get("repair")
    edit = decision.get("edit")
    route = decision.get("route")
    conf = decision.get("confidence")
    if verdict not in taxonomy["verdicts"]:
        v.append(f"verdict {verdict!r} not in taxonomy")
    if verdict == "defect":
        if repair not in taxonomy["repairs"]:
            v.append(f"defect without valid repair ({repair!r})")
    elif repair is not None:
        v.append(f"repair {repair!r} set but verdict is {verdict!r}")
    if repair in taxonomy["repairs"] and edit:
        allowed = taxonomy["repairs"][repair]["fields"]
        if edit.get("field") not in allowed:
            v.append(f"edit field {edit.get('field')!r} outside "
                     f"{repair} whitelist {allowed}")
        find = edit.get("find")
        src = source_field(view, edit.get("field"))
        if find is not None and src is not None and find not in src:
            v.append(f"find string not found in {edit.get('field')} source")
    if not isinstance(conf, (int, float)) or not (0 <= conf <= 1):
        v.append(f"bad confidence {conf!r}")
    # route is not a violation: the engine re-derives it deterministically
    return v


def expected_route(decision, taxonomy):
    verdict = decision.get("verdict")
    repair = decision.get("repair")
    if verdict in NO_CHANGE_VERDICTS:
        return "no_change"
    if verdict == "defect" and repair in taxonomy["repairs"]:
        if not taxonomy["repairs"][repair]["auto"]:
            return "faculty_review"
        if (decision.get("confidence") or 0) >= AUTO_APPLY_MIN_CONFIDENCE \
                and decision.get("edit"):
            return "auto_apply"
    return "faculty_review"


# ------------------------------------------------------------------------ run

def run_question(qid, view, reports, taxonomy, key, model,
                 fallbacks=()):
    cache = RUNS / f"{qid}.solve.json"
    if cache.exists():
        cached = json.loads(cache.read_text())
        solve = cached.get("solve", cached)
        model_a = cached.get("model", model)
    else:
        raw_a, model_a = gemini_call(build_call_a(view), key, model,
                                     fallbacks=fallbacks)
        solve = parse_json(raw_a)
        RUNS.mkdir(exist_ok=True)
        cache.write_text(json.dumps(
            {"model": model_a, "solve": solve}, ensure_ascii=False))
    raw_b, model_b = gemini_call(build_call_b(view, solve, reports, taxonomy),
                                 key, model, fallbacks=fallbacks)
    parsed_b = parse_json(raw_b)
    # Model sometimes returns the bare list instead of {"decisions": [...]}
    decisions = parsed_b["decisions"] if isinstance(parsed_b, dict) else parsed_b
    return {"questionId": qid, "runId": uuid.uuid4().hex[:12],
            "model_solve": model_a, "model_triage": model_b,
            "independent_solve": solve,
            "decisions": decisions}


def assemble(taxonomy):
    """Merge run shards -> results.json, applying review overrides + guards."""
    questions, reports, _ = load_all()
    overrides_path = ROOT / "pipeline" / "review_overrides.json"
    overrides = {}
    if overrides_path.exists():
        for o in json.loads(overrides_path.read_text())["overrides"]:
            overrides[o["reportId"]] = o
    by_q = {}
    for r in reports:
        by_q.setdefault(r["questionId"], []).append(r)
    results, quarantined = [], []
    for qid, reps in by_q.items():
        shard_path = RUNS / f"{qid}.json"
        if not shard_path.exists():
            quarantined.append({"questionId": qid, "reason": "no run shard"})
            continue
        shard = json.loads(shard_path.read_text())
        view = _view_for(qid, questions)
        seen = set()
        for d in shard["decisions"]:
            rid = d.get("reportId")
            seen.add(rid)
            if rid in overrides:
                o = overrides[rid]
                d = {"reportId": rid, "verdict": o["verdict"],
                     "repair": o["repair"], "edit": o["edit"],
                     "confidence": o["confidence"], "evidence": o["evidence"],
                     "student_reply": o["student_reply"],
                     "route": None}
            violations = guard(d, view, taxonomy)
            if violations:
                quarantined.append({"reportId": rid, "decision": d,
                                    "violations": violations})
                continue
            # engine owns the final route
            d["route"] = expected_route(d, taxonomy)
            results.append({
                "reportId": rid, "questionId": qid,
                "verdict": d["verdict"], "repair": d.get("repair"),
                "edit": d.get("edit"), "route": d["route"],
                "confidence": round(float(d["confidence"]), 2),
                "evidence": d["evidence"],
                "student_reply": d["student_reply"],
            })
        missing = {r["reportId"] for r in reps} - seen
        for rid in missing:
            quarantined.append({"reportId": rid,
                                "reason": "missing from Call B output"})
    results.sort(key=lambda x: x["reportId"])
    (ROOT / "results.json").write_text(
        json.dumps(results, indent=1, ensure_ascii=False), encoding="utf-8")
    QUARANTINE.write_text(json.dumps(quarantined, indent=1, ensure_ascii=False),
                          encoding="utf-8")
    print(f"results.json: {len(results)}/44 decisions written; "
          f"{len(quarantined)} quarantined (pipeline/quarantine.json)")


def _view_for(qid, questions):
    from common import case_view
    return case_view(questions[qid])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", default=None,
                    help="reportIds to (re)run")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--assemble", action="store_true")
    ap.add_argument("--key-file", default=None,
                    help="path to a file containing only the API key")
    ap.add_argument("--pace", type=float, default=3.0,
                    help="seconds between API calls (free-tier safety)")
    ap.add_argument("--max-seconds", type=float, default=None,
                    help="stop starting new questions after this many seconds")
    ap.add_argument("--workers", type=int, default=2,
                    help="parallel questions (free-tier RPM headroom)")
    args = ap.parse_args()

    questions, reports, taxonomy = load_all()
    if args.assemble:
        assemble(taxonomy)
        return

    key = None
    if args.key_file:
        key = Path(args.key_file).read_text().strip()
    key = key or os.environ.get("GEMINI_API_KEY")
    model = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
    fallbacks = [m for m in os.environ.get(
        "GEMINI_FALLBACKS", "gemini-3.1-flash-lite").split(",") if m]
    if not key:
        sys.exit("no API key: set GEMINI_API_KEY or pass --key-file")

    by_q = {}
    for r in reports:
        by_q.setdefault(r["questionId"], []).append(r)
    if args.only:
        wanted = set(args.only)
        by_q = {q: [r for r in rs if r["reportId"] in wanted]
                for q, rs in by_q.items()}
        by_q = {q: rs for q, rs in by_q.items() if rs}

    RUNS.mkdir(exist_ok=True)
    todo = [qid for qid in by_q
            if args.force or not (RUNS / f"{qid}.json").exists()]
    print(f"{len(todo)} questions to run (model {model})")
    from concurrent.futures import ThreadPoolExecutor
    started = time.time()
    done = 0

    def work(item):
        i, qid = item
        view = _view_for(qid, questions)
        reps = by_q[qid]
        ids = ",".join(r["reportId"] for r in reps)
        print(f"[{i + 1}/{len(todo)}] {qid} ({ids}) ...", flush=True)
        shard = run_question(qid, view, reps, taxonomy, key, model,
                             fallbacks)
        (RUNS / f"{qid}.json").write_text(
            json.dumps(shard, indent=1, ensure_ascii=False), encoding="utf-8")
        return qid

    futures = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, qid in enumerate(todo):
            if args.max_seconds and time.time() - started > args.max_seconds:
                print(f"time budget reached; {len(todo) - done} questions "
                      f"left. Re-run to resume.")
                break
            if i and args.pace:
                time.sleep(args.pace / args.workers)
            fut = pool.submit(work, (i, qid))
            futures.append(fut)
        for fut in futures:
            try:
                fut.result()
                done += 1
            except Exception as e:
                print(f"  QUESTION FAILED: {e!r} - will retry on next run")
    print(f"{done} questions done this run; "
          f"now: python3 pipeline/triage.py --assemble")


if __name__ == "__main__":
    main()
