"""Parse every question into a reasoning view and dump previews for eyeballing.

Usage: python3 pipeline/parse.py
Writes:
  pipeline/cases.json        - one normalized case per report, joined to its question
  preview/<questionId>.txt   - human-readable dump per question (gitignored)
Prints a summary and flags questions where parsing looks lossy.
"""
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from common import (DATA_DIR, case_view, extract_options, html_to_text,
                    inner, load_all, parse_answer)

ROOT = Path(__file__).resolve().parent.parent
PREVIEW = ROOT / "preview"


def main():
    questions, reports, taxonomy = load_all()
    by_question = defaultdict(list)
    for r in reports:
        by_question[r["questionId"]].append(r)

    PREVIEW.mkdir(exist_ok=True)
    flags = []
    cases = []
    for qid, q in sorted(questions.items()):
        view = case_view(q)
        payload = inner(q)
        lines = [
            f"QID {qid} | {view['type']} | {view['subject']} / {view['chapter']} "
            f"| {view['level']}",
            f"STORED ANSWER: {json.dumps(view['stored_answer'])}",
        ]
        if view["answer_malformed_note"]:
            lines.append(f"ANSWER FIELD: {view['answer_malformed_note']}")
            flags.append((qid, view["answer_malformed_note"]))
        lines += ["--- STEM ---", view["stem"], "--- OPTIONS ---"]
        for o in view["options"]:
            lines.append(f"  ({o['label']}) {o['text']}")
            if not o["text"]:
                flags.append((qid, f"option {o['label']} is blank"))
        labels = [o["label"] for o in view["options"]]
        if view["type"] in ("scq", "mcq"):
            for want in "ABCD":
                if want not in labels:
                    flags.append((qid, f"option {want} missing from parsed list"))
        lines += ["--- SOLUTION ---", view["solution_text"]]
        if view["solution_text"].count("[MATH") or view["stem"].count("[MATH"):
            flags.append((qid, "math fallback used (unparseable MathML fragment)"))
        reps = by_question.get(qid, [])
        if reps:
            lines.append("--- REPORTS ---")
            for r in reps:
                lines.append(f"  {r['reportId']} ({r['source']}, "
                             f"{r['reportedAt']}): {r['comment']}")
        (PREVIEW / f"{qid}.txt").write_text("\n".join(lines), encoding="utf-8")

        for r in reps:
            cases.append({
                "report": r,
                "question": {k: v for k, v in view.items()},
            })

    with open(ROOT / "pipeline" / "cases.json", "w", encoding="utf-8") as f:
        json.dump(cases, f, indent=1, ensure_ascii=False)

    n_types = defaultdict(int)
    for q in questions.values():
        n_types[q["questionType"]] += 1
    print(f"{len(questions)} questions {dict(n_types)}, {len(reports)} reports "
          f"over {len(by_question)} questions")
    print(f"{len(cases)} cases written to pipeline/cases.json, "
          f"{len(list(PREVIEW.iterdir()))} previews in preview/")
    print(f"\n{len(flags)} parse flags:")
    for qid, msg in flags:
        print(f"  {qid}: {msg}")


if __name__ == "__main__":
    main()
