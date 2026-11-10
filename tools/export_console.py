"""Export everything the faculty console needs into console/public/data/.

console_data.json: {questions: {qid: view}, reports: [...], results: [...]}
The console is fully static: no backend, no API key.
"""
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "pipeline"))
from common import case_view, load_all  # noqa: E402


def main():
    questions, reports, _ = load_all()
    out_q = {}
    for qid, q in questions.items():
        v = case_view(q)
        out_q[qid] = {
            "id": qid, "type": v["type"], "subject": v["subject"],
            "chapter": v["chapter"], "level": v["level"],
            "stem": v["stem"], "options": v["options"],
            "solutionText": v["solution_text"],
            "storedAnswer": v["stored_answer"],
            "rawQuestionHtml": v["raw_question_html"],
            "rawSolutionHtml": v["raw_solution_html"],
        }
    import os
    results_path = Path(os.environ.get("RESULTS_JSON", ROOT / "results.json"))
    results = json.loads(results_path.read_text()) if results_path.exists() else []
    dest = ROOT / "console" / "public" / "data"
    dest.mkdir(parents=True, exist_ok=True)
    payload = {"questions": out_q, "reports": reports, "results": results}
    (dest / "console_data.json").write_text(
        json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    print(f"exported {len(out_q)} questions, {len(reports)} reports, "
          f"{len(results)} results -> console/public/data/console_data.json")


if __name__ == "__main__":
    main()
