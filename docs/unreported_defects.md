# Bonus: defects nobody (correctly) reported

The brief's bonus: "our data has defects nobody reported. Find them."
Two independent sweeps were run (AI-assisted, separate from the triage
engine's own calls); conclusions below are that independent review's,
labeled as such -  not the employer's answer key.

## Sweep 1 -  the 4 zero-report questions: clean

Every question with no reports was independently re-solved:

| Question | Check | Result |
|---|---|---|
| Lens power (integer) | P = 1/f combination | 5 D verifies correct |
| Image-size ratio (integer) | magnification ratio | 16 verifies correct |
| Dialysis assertion | assertion/reason consistency | internally consistent |
| Varying-dielectric capacitor | full solve | 5 V (option A) verifies correct |

A mechanical scan of all 43 questions (raw-LaTeX leaks, exam-year tags,
blank/missing/duplicate options, malformed answer arrays, missing solutions,
figure references with no image, noise text) flagged 8 questions -  every one
of them already had at least one report and is covered in results.json.

## Sweep 2 -  5 defects hiding behind wrong complaints

The more interesting finds: reports whose comment points at the wrong thing
while the question carries a different, real defect. The comment is a lead,
not the diagnosis.

1. **R020's question** -  complaint: "I marked A B D and still got it wrong".
   True defect: the stored answer is a single string `["A, B, D"]` instead of
   `["A","B","D"]`, so a correct multi-select is graded wrong. Repair:
   answer_key (normalize the array). This also *explains* the student's
   experience.
2. **R021's question** -  complaint: negative marking confusion. True defect:
   a single-correct physics question stored as `mcq` with answer `["", "B"]`
   (empty first element). Repair: type_mismatch.
3. **R016** -  complaint: general confusion about the answer. True defect: the
   solution's last line says "a = 40 cm" where its own working gives
   a^2 = 400 → 20 cm (the key 20 is right). Repair: solution_fix.
4. **R034** -  complaint disputes the assertion. Additionally found: the stored
   solution is self-contradictory (derives the assertion false, then via a
   wrong intensity formula concludes it true). Phase difference pi/2 gives
   I = 2I0·cos²(pi/4) = I0, so Assertion TRUE, Reason FALSE → key should be C,
   not D. Repair: answer_key.
5. **R004** -  complaint quotes a wrong value ("8225"). Both the student AND
   the key are wrong: the stored solution computes 4800 = option D, but the
   key points at A. Repair: answer_key.

## Why this matters

Report volume is a symptom counter, not a defect detector. The solver pass
that produced these findings costs two model calls per question; running it
across the full bank nightly would catch this whole class before a student
ever trips on it.
