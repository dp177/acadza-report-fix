"""Validate results.json against taxonomy.json and the raw data. No LLM.

Checks:
  1. All 44 reportIds present, no extras, no duplicates.
  2. Every verdict/repair key exists in taxonomy.json.
  3. repair set only when verdict == defect; edit fields inside the repair's
     whitelist; auto:false repairs routed faculty_review.
  4. Every edit.find matches the raw source content of its field.
  5. Routes follow the engine rules (auto_apply needs auto:true + conf >= .85).

Usage: python3 tools/validate.py
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
from common import case_view, load_all  # noqa: E402

NO_CHANGE_VERDICTS = {"no_error", "display_issue", "app_issue",
                      "language_mode", "not_actionable", "already_fixed"}


def main():
    questions, reports, taxonomy = load_all()
    results = json.loads((ROOT / "results.json").read_text())
    want = {r["reportId"] for r in reports}
    got = [r["reportId"] for r in results]
    problems = []

    dupes = {x for x in got if got.count(x) > 1}
    if dupes:
        problems.append(f"duplicate reportIds: {sorted(dupes)}")
    if set(got) != want:
        problems.append(f"coverage mismatch: missing {sorted(want - set(got))}, "
                        f"extra {sorted(set(got) - want)}")

    views = {}
    for row in results:
        rid = row["reportId"]
        qid = row["questionId"]
        if qid not in views:
            if qid not in questions:
                problems.append(f"{rid}: unknown questionId {qid}")
                continue
            views[qid] = case_view(questions[qid])
        view = views[qid]
        verdict, repair, edit, route = (row.get(k) for k in
                                        ("verdict", "repair", "edit", "route"))
        conf = row.get("confidence")
        if verdict not in taxonomy["verdicts"]:
            problems.append(f"{rid}: verdict {verdict!r} not in taxonomy")
        if verdict == "defect":
            if repair not in taxonomy["repairs"]:
                problems.append(f"{rid}: defect with bad repair {repair!r}")
        elif repair is not None:
            problems.append(f"{rid}: repair set but verdict {verdict!r}")
        if repair in taxonomy["repairs"]:
            allowed = taxonomy["repairs"][repair]["fields"]
            auto = taxonomy["repairs"][repair]["auto"]
            if not auto and route == "auto_apply":
                problems.append(f"{rid}: auto:false repair {repair} "
                                f"routed auto_apply")
            if edit:
                if edit.get("field") not in allowed:
                    problems.append(f"{rid}: edit field {edit.get('field')!r} "
                                    f"outside {repair} whitelist {allowed}")
                src = {"question": view["stem"] + "\n" + "\n".join(
                           o["text"] for o in view["options"]),
                       "solution": view["solution_text"],
                       "answer": json.dumps(view["stored_answer"])}.get(
                           edit.get("field"), "")
                find = edit.get("find")
                if find and find not in src and edit.get("field") != "answer":
                    problems.append(f"{rid}: find string not found in "
                                    f"{edit.get('field')}")
            if auto and route == "auto_apply" and (conf or 0) < 0.85:
                problems.append(f"{rid}: auto_apply below confidence floor")
        if verdict in NO_CHANGE_VERDICTS and route != "no_change":
            problems.append(f"{rid}: {verdict} must route no_change")
        if route == "auto_apply" and not edit:
            problems.append(f"{rid}: auto_apply without an edit")
        for req in ("evidence", "student_reply"):
            if not row.get(req):
                problems.append(f"{rid}: missing {req}")

    print(f"{len(results)} rows | {len(problems)} problems")
    for p in problems:
        print(f"  FAIL {p}")
    print("\nreportId  verdict          repair             route           conf  evidence")
    for row in results:
        print(f"{row['reportId']:<9} {row['verdict']:<16} "
              f"{str(row.get('repair')):<18} {row['route']:<15} "
              f"{row.get('confidence', 0):<5.2f} {row['evidence'][:60]}")
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
