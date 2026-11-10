"""Shared data loading and content parsing for the Acadza report->fix pipeline.

Every question carries untrusted HTML + inline MathML in `<type>.question` and
`<type>.solution`. We keep the raw HTML untouched (the console sanitizes and
renders it) and build a plain-text "reasoning view" for the LLM: MathML becomes
linear text (mfrac -> a/b, msup -> ^, msub -> _, msqrt -> sqrt(...)) so the
model can actually solve the physics/math.
"""
import html as _html
import json
import re
from pathlib import Path
from xml.etree import ElementTree as ET

DATA_DIR = Path(__file__).resolve().parent.parent / "data"

MML_NS = "http://www.w3.org/1998/Math/MathML"


def load_json(name):
    with open(DATA_DIR / name, encoding="utf-8") as f:
        return json.load(f)


def load_all():
    questions = {q["_id"]: q for q in load_json("questions.json")}
    reports = load_json("reports.json")
    taxonomy = load_json("taxonomy.json")
    return questions, reports, taxonomy


def inner(question):
    """The per-type payload (scq / mcq / integerQuestion)."""
    return question.get(question["questionType"]) or {}


# ---------------------------------------------------------------- MathML -> text

def _mml_to_text(el):
    tag = el.tag.split("}")[-1]
    kids = list(el)
    txt = el.text or ""
    if tag in ("mi", "mn", "mo", "mtext"):
        return txt
    if tag == "mfrac" and len(kids) >= 2:
        return f"({_mml_to_text(kids[0])})/({_mml_to_text(kids[1])})"
    if tag == "msup" and len(kids) >= 2:
        return f"{_mml_to_text(kids[0])}^({_mml_to_text(kids[1])})"
    if tag == "msub" and len(kids) >= 2:
        return f"{_mml_to_text(kids[0])}_({_mml_to_text(kids[1])})"
    if tag == "msubsup" and len(kids) >= 3:
        return (f"{_mml_to_text(kids[0])}_({_mml_to_text(kids[1])})"
                f"^({_mml_to_text(kids[2])})")
    if tag == "msqrt":
        return "sqrt(" + "".join(_mml_to_text(k) for k in kids) + ")"
    if tag == "mroot" and len(kids) >= 2:
        return f"root[{_mml_to_text(kids[1])}]({_mml_to_text(kids[0])})"
    if tag == "mfenced":
        return "(" + "".join(_mml_to_text(k) for k in kids) + ")"
    if tag == "munderover" and len(kids) >= 3:
        return (f"{_mml_to_text(kids[0])}_({_mml_to_text(kids[1])})"
                f"^({_mml_to_text(kids[2])})")
    if tag == "munder" and len(kids) >= 2:
        return f"{_mml_to_text(kids[0])}_({_mml_to_text(kids[1])})"
    if tag == "mover" and len(kids) >= 2:
        return f"{_mml_to_text(kids[0])}^({_mml_to_text(kids[1])})"
    # mrow, math, mstyle, semantics, anything else: concatenate children + tails
    return txt + "".join(_mml_to_text(k) + (k.tail or "") for k in kids)


def _math_fallback(frag):
    """MathML fragment is not valid XML: keep its visible symbols textually."""
    txt = re.sub(r"<[^>]+>", "", frag)
    return " " + _html.unescape(txt).strip() + " "


def _convert_math(frag):
    cleaned = _html.unescape(frag)
    cleaned = re.sub(r'xmlns(:\w+)?="[^"]*"', "", cleaned, count=1)
    cleaned = cleaned.replace("<math", f'<math xmlns="{MML_NS}"', 1)
    try:
        return " " + _mml_to_text(ET.fromstring(cleaned)).strip() + " "
    except ET.ParseError:
        return _math_fallback(frag)


def html_to_text(raw):
    """Raw question/solution HTML -> plain-text reasoning view."""
    if not raw:
        return ""
    out = re.sub(r"<math[^>]*>.*?</math>", lambda m: _convert_math(m.group(0)),
                 raw, flags=re.S)
    out = re.sub(r"<br\s*/?>", "\n", out)
    out = re.sub(r"</(h\d|p|div|li|tr|ol|ul)>", "\n", out)
    out = re.sub(r"<[^>]+>", "", out)
    out = _html.unescape(out)
    out = out.replace("\xa0", " ")  # nbsp: keep find/replace matching predictable
    out = out.replace("&=", "=")  # alignment artifacts from aligned equations
    out = re.sub(r"[ \t]+", " ", out)
    out = re.sub(r"\n\s*\n+", "\n", out)
    return out.strip()


# ------------------------------------------------------------------- options

_OPTION_RE = re.compile(r"\(\s*([A-D])\s*\)")


def extract_options(raw_html):
    """Pull (A)..(D) options out of the question HTML.

    Returns (stem_text, options) where options is a list of
    {"label": "A", "text": "..."} and stem_text is the question without the
    option block. Options found via <ol>/<li> or inline (A) markers.
    """
    text = html_to_text(raw_html)
    marks = list(_OPTION_RE.finditer(text))
    if len(marks) < 2:
        return text, []
    stem = text[:marks[0].start()].strip()
    options = []
    for i, m in enumerate(marks):
        end = marks[i + 1].start() if i + 1 < len(marks) else len(text)
        body = text[m.end():end].strip().strip(".").strip()
        options.append({"label": m.group(1), "text": body})
    return stem, options


def parse_answer(answer, qtype):
    """Normalize the stored answer. Returns (value, malformed_note_or_None)."""
    if isinstance(answer, list):
        flat, bad = [], []
        for item in answer:
            if isinstance(item, str) and ("," in item):
                bad.append(item)
                flat.extend(p.strip() for p in item.split(",") if p.strip())
            elif item in ("", None):
                bad.append(repr(item))
            else:
                flat.append(item)
        note = None
        if bad:
            note = f"malformed answer array entries: {bad}; intended reads as {flat}"
        return flat, note
    return answer, None


def case_view(question):
    """Full reasoning view of one question for the LLM prompts."""
    payload = inner(question)
    qtype = question["questionType"]
    q_html = payload.get("question") or ""
    s_html = payload.get("solution") or ""
    stem, options = extract_options(q_html)
    answer, malformed = parse_answer(payload.get("answer"), qtype)
    return {
        "id": question["_id"],
        "type": qtype,
        "subject": question.get("subject"),
        "chapter": question.get("chapter"),
        "level": question.get("level"),
        "stem": stem,
        "options": options,
        "solution_text": html_to_text(s_html),
        "stored_answer": answer,
        "stored_answer_raw": payload.get("answer"),
        "answer_malformed_note": malformed,
        "raw_question_html": q_html,
        "raw_solution_html": s_html,
    }
