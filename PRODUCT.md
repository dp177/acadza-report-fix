# PRODUCT.md

**Who loses the most when a question is broken?**
Not the student who reports it -  they at least noticed. The biggest loser is
the student who *doesn't* report it: the one who solves correctly, gets marked
wrong against a bad key, loses marks and rank in a mock, and quietly decides
they don't understand the chapter. Multiply by every student who meets that
question before anyone fixes it. That is why the design does not treat a
report as the unit of work -  the *question* is. Reports are grouped per
question, every reported question gets an independent blind solve (not just a
reply to the complaint), and the bonus sweep ran the same check over questions
with zero reports. It found 5 real defects hiding behind complaints about
something else entirely (R004, R016, R020, R021, R034). Report volume counts
symptoms; the solve finds the disease. The queue ordering reflects the same
math: defect impact times affected students first, not first-in-first-out.

**What I would never let the AI auto-apply.**
Anything where the fix is *authored*, not *verified*. Concretely: all six
`auto:false` repair classes -  identical_options, diagram, wrong_question,
unsound, wrong_chapter, syllabus -  plus any edit that invents content (a
missing option, a new distractor, a rewritten solution step). A verified
correction ("the key says C; the blind solve AND the stored
solution's own working both land on A") has a checkable right answer; an authored one does not, and a
confidently wrong authored option looks exactly like a correct one to the next
8 lakh students. Syllabus and chapter calls are policy decisions, not physics
 -  the AI has no business deciding what NEET covers. Same reason the model
proposes routes but code re-derives them: the last line of defense on what
touches production is deterministic, not probabilistic.

**One metric for week 1.**
Revert rate on auto-applied fixes: of the edits auto-applied this week, how
many did faculty revert or edit within 7 days. It is the direct measurement
of the highest-risk production action the system takes. Target under 2%; any revert
gets its evidence string reviewed as a case study. (Report volume and
time-to-fix are vanity next to this -  a fast system that applies wrong fixes
is worse than no system.)

**One idea beyond the brief.**
Run the blind solver over the entire question bank on a schedule, before
anyone reports anything. This assignment proves the value: the sweep found
defects on questions whose reports were about something else. The cost is
real, not negligible: two model calls per question across ~8 lakh questions is
a nightly batch job that belongs on the cheapest capable model, with caching
so only changed questions re-run. What stays near-free is the human side:
only flagged disagreements reach faculty. The report queue becomes the safety
net instead of the detection system. Faculty stop being the first line of
defense and become the last.
