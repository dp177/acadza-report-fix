import React, { useEffect, useMemo, useState } from 'react'
import { sanitizeContentHtml } from './sanitize.js'

const AUDIT_KEY = 'acadza_audit_v2'
const DECISIONS_KEY = 'acadza_decisions_v2'
const PATCHES_KEY = 'acadza_patches_v2'

// Urgency: how many students a broken question keeps hurting until fixed.
const REPAIR_URGENCY = {
  answer_key: 6, unsound: 6, option_repair: 5, type_mismatch: 5,
  solution_fix: 4, stem_data: 4, wrong_question: 4, identical_options: 4,
  diagram: 3, wrong_chapter: 2, markup_leak: 2, notation: 2,
  answer_form: 1, spelling: 1, noise: 1, exam_reference: 1, syllabus: 1,
}

function loadJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}

// Identity of a proposed fix: two reports proposing this exact same thing
// are duplicates and resolve together.
function fixSignature(res) {
  return JSON.stringify([res.verdict, res.repair, res.edit || null])
}

function contextSnippet(source, find) {
  if (source == null || !find) return null
  const i = source.indexOf(find)
  if (i < 0) return null
  const a = Math.max(0, i - 60), b = Math.min(source.length, i + find.length + 60)
  return { before: source.slice(a, i), after: source.slice(i + find.length, b) }
}

function Badge({ verdict }) {
  const cls = verdict === 'defect' ? 'defect'
    : verdict === 'no_error' ? 'no_error'
    : ['display_issue', 'app_issue', 'language_mode', 'already_fixed'].includes(verdict) ? verdict
    : 'other'
  return <span className={`badge ${cls}`}>{(verdict || '').replace('_', ' ')}</span>
}

function RouteTag({ route }) {
  const label = route === 'auto_apply' ? 'recommends auto-apply'
    : route === 'faculty_review' ? 'needs faculty review'
    : 'no change'
  return <span className="route-tag">{label}</span>
}

function Diff({ edit, source, editing, onChange }) {
  if (!edit) return <div className="evidence" style={{ color: 'var(--muted)' }}>No edit proposed.</div>
  if (editing) {
    return (
      <div className="diff">
        <div className="field-name">field: {edit.field}</div>
        <label>find</label>
        <input value={edit.find || ''} onChange={e => onChange({ ...edit, find: e.target.value })} />
        <label>replace</label>
        <input value={edit.replace || ''} onChange={e => onChange({ ...edit, replace: e.target.value })} />
      </div>
    )
  }
  const ctx = contextSnippet(source, edit.find)
  return (
    <div className="diff">
      <div className="field-name">field: {edit.field}</div>
      {ctx ? (
        <div>
          <span className="ctx">…{ctx.before}</span>
          <del>{edit.find}</del>
          <span className="ctx">{ctx.after}…</span>
          <div style={{ marginTop: 6 }}>
            <span className="ctx">→ </span><ins>{edit.replace}</ins>
          </div>
        </div>
      ) : (
        <div><del>{String(edit.find)}</del> → <ins>{String(edit.replace)}</ins></div>
      )}
    </div>
  )
}

export default function App() {
  const [data, setData] = useState(null)
  const [filter, setFilter] = useState('all')
  const [sel, setSel] = useState(null)
  const [audit, setAudit] = useState(() => loadJSON(AUDIT_KEY, []))
  const [decisions, setDecisions] = useState(() => loadJSON(DECISIONS_KEY, {}))
  const [patches, setPatches] = useState(() => loadJSON(PATCHES_KEY, {}))
  const [editing, setEditing] = useState(false)
  const [draftEdit, setDraftEdit] = useState(null)
  const [conflict, setConflict] = useState(null)

  useEffect(() => {
    fetch('./data/console_data.json').then(r => r.json()).then(setData)
  }, [])

  function persist(key, value, setter) {
    setter(value)
    localStorage.setItem(key, JSON.stringify(value))
  }

  const groups = useMemo(() => {
    if (!data) return []
    const byQ = {}
    for (const res of data.results) {
      const q = data.questions[res.questionId]
      if (!q) continue
      byQ[res.questionId] ||= { question: q, cases: [], urgency: 0, latest: '' }
      const g = byQ[res.questionId]
      g.cases.push(res)
      g.urgency = Math.max(g.urgency, REPAIR_URGENCY[res.repair] || 0)
      const rep = data.reports.find(r => r.reportId === res.reportId)
      if (rep && rep.reportedAt > g.latest) g.latest = rep.reportedAt
    }
    let gs = Object.values(byQ)
    gs.sort((a, b) => b.urgency - a.urgency
      || b.cases.length - a.cases.length
      || (b.latest < a.latest ? -1 : 1))
    const keep = c => filter === 'all'
      || (filter === 'auto' && c.route === 'auto_apply')
      || (filter === 'review' && c.route === 'faculty_review')
      || (filter === 'nochange' && c.route === 'no_change')
    return gs.map(g => ({ ...g, cases: g.cases.filter(keep) })).filter(g => g.cases.length)
  }, [data, filter])

  const selected = useMemo(() => {
    if (!data || !sel) return null
    const res = data.results.find(r => r.reportId === sel)
    if (!res) return null
    return { res, q: data.questions[res.questionId] }
  }, [data, sel])

  const counts = useMemo(() => {
    if (!data) return {}
    const c = { total: data.results.length, defect: 0, auto: 0, review: 0, done: 0 }
    for (const r of data.results) {
      if (r.verdict === 'defect') c.defect++
      if (r.route === 'auto_apply') c.auto++
      if (r.route === 'faculty_review') c.review++
      if (decisions[r.reportId]) c.done++
    }
    return c
  }, [data, decisions])

  // Working view of a question: stored content with applied patches.
  function workingQuestion(q) {
    const qp = patches[q.id] || {}
    return {
      answer: qp.answer ? qp.answer.replace : q.storedAnswer,
      questionHtml: qp.question
        ? (q.rawQuestionHtml || '').split(qp.question.find).join(qp.question.replace)
        : q.rawQuestionHtml,
      solutionText: qp.solution
        ? (q.solutionText || '').split(qp.solution.find).join(qp.solution.replace)
        : q.solutionText,
      patchedFields: Object.keys(qp),
    }
  }

  function addAudit(entries) {
    const next = [...audit, ...entries]
    persist(AUDIT_KEY, next, setAudit)
  }

  // Conflict: another report on this question already patched the same field
  // with different content.
  function findConflict(res, editToApply) {
    if (!editToApply) return null
    const qp = patches[res.questionId] || {}
    const existing = qp[editToApply.field]
    if (existing && existing.replace !== editToApply.replace && existing.byReportId !== res.reportId) {
      return { field: editToApply.field, existing }
    }
    return null
  }

  function decide(action) {
    if (!selected) return
    const { res } = selected
    const editToApply = action === 'edited' ? draftEdit : res.edit
    setConflict(null)

    if ((action === 'approved' || action === 'edited')) {
      const c = findConflict(res, editToApply)
      if (c) {
        setConflict({
          field: c.field,
          byReportId: c.existing.byReportId,
          existingReplace: c.existing.replace,
          attemptedReplace: editToApply.replace,
        })
        return
      }
    }

    const ts = new Date().toISOString()
    const entries = [{ ts, action, reportId: res.reportId, questionId: res.questionId }]
    const nextDecisions = { ...decisions, [res.reportId]: { action, ts } }
    let nextPatches = patches

    if ((action === 'approved' || action === 'edited')) {
      if (action === 'edited') entries[0].edit = draftEdit
      if (editToApply) {
        nextPatches = {
          ...patches,
          [res.questionId]: {
            ...(patches[res.questionId] || {}),
            [editToApply.field]: { find: editToApply.find, replace: editToApply.replace, byReportId: res.reportId, ts },
          },
        }
        persist(PATCHES_KEY, nextPatches, setPatches)
      }
      // Duplicate reports proposing the identical fix resolve with it.
      const sig = fixSignature(res)
      for (const other of data.results) {
        if (other.reportId === res.reportId) continue
        if (other.questionId !== res.questionId) continue
        if (decisions[other.reportId]) continue
        if (fixSignature(other) === sig) {
          nextDecisions[other.reportId] = { action: 'approved', ts, via: res.reportId }
          entries.push({ ts, action: 'approved', reportId: other.reportId, questionId: res.questionId, note: `same fix as ${res.reportId}, resolved together` })
        }
      }
    }

    persist(DECISIONS_KEY, nextDecisions, setDecisions)
    addAudit(entries)
    setEditing(false)
  }

  useEffect(() => {
    function onKey(e) {
      const t = e.target
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) return
      if (!selected) return
      if (e.key === 'a') decide('approved')
      if (e.key === 'r') decide('rejected')
      if (e.key === 'e') { setDraftEdit(selected.res.edit); setEditing(true) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function exportAudit() {
    const payload = {
      exported_at: new Date().toISOString(),
      note: 'decisions + applied working-copy patches from this review console',
      audit, decisions, patches,
    }
    const blob = new Blob([JSON.stringify(payload, null, 1)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'audit_log.json'
    a.click()
  }

  if (!data) return <div className="empty">Loading console data…</div>

  const selDecision = sel ? decisions[sel] : null
  const selWorking = selected ? workingQuestion(selected.q) : null
  const dupCount = selected
    ? data.results.filter(o => o.reportId !== sel && o.questionId === selected.res.questionId && fixSignature(o) === fixSignature(selected.res)).length
    : 0

  return (
    <>
      <div className="banner">Console loads precomputed AI results. Approving applies the fix to the working copy and records it in the audit log; nothing here is live until faculty decides.</div>
      <header className="top">
        <h1>Faculty Review</h1>
        <div className="stats">
          <span>{counts.total} reports</span>
          <span>{counts.defect} defects</span>
          <span>{counts.review} need review</span>
          <span>{counts.auto} recommended auto-apply</span>
          <span>{counts.done} decided</span>
        </div>
        <div className="spacer" />
        <div className="filters">
          {[['all', 'All'], ['review', 'Needs review'], ['auto', 'Recommended auto-apply'], ['nochange', 'No change']].map(([k, label]) => (
            <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>
          ))}
        </div>
        <button className="export" onClick={exportAudit}>Export audit log (JSON)</button>
      </header>
      <main className="layout">
        <div className="queue">
          {groups.map(g => (
            <div className="qgroup" key={g.question.id}>
              <div className="qhead">
                <div className="qtitle">{g.question.chapter} <span className="count-badge">{g.cases.length}</span></div>
                <div className="qmeta">
                  <span>{g.question.subject}</span><span>{g.question.type}</span>
                  <span title={g.question.id}>#{g.question.id.slice(-6)}</span>
                </div>
              </div>
              {g.cases.map(c => {
                const rep = data.reports.find(r => r.reportId === c.reportId)
                const st = decisions[c.reportId]
                return (
                  <div key={c.reportId}
                    className={`case-row ${sel === c.reportId ? 'sel' : ''}`}
                    onClick={() => { setSel(c.reportId); setEditing(false); setConflict(null) }}>
                    <span className="cid">{c.reportId}</span>
                    <Badge verdict={c.verdict} />
                    <RouteTag route={c.route} />
                    {st && <span className={`status-dot ${st.action}`}>● {st.action}{st.via ? ` (with ${st.via})` : ''}</span>}
                    <div className="comment">“{rep?.comment}”</div>
                  </div>
                )
              })}
            </div>
          ))}
          {!groups.length && <div className="empty">Nothing in this filter.</div>}
        </div>
        <div className="detail">
          {!selected ? <div className="empty">Pick a case from the queue. Shortcuts: <kbd>a</kbd> approve, <kbd>e</kbd> edit, <kbd>r</kbd> reject.</div> : (
            <>
              <h2>{selected.res.reportId} <Badge verdict={selected.res.verdict} /> <RouteTag route={selected.res.route} /> <span className="route-tag">· confidence {selected.res.confidence}</span></h2>
              <div className="sub">
                {selected.q.subject} / {selected.q.chapter} · {selected.q.type} ·{' '}
                stored answer: {selWorking.patchedFields.includes('answer')
                  ? <><del className="old-answer">{JSON.stringify(selected.q.storedAnswer)}</del> → <ins className="new-answer">{JSON.stringify(selWorking.answer)}</ins> (applied)</>
                  : JSON.stringify(selected.q.storedAnswer)}
              </div>

              {selDecision && (
                <div className={`decided-banner ${selDecision.action}`}>
                  {selDecision.action === 'rejected'
                    ? `Rejected ${selDecision.ts.slice(0, 16).replace('T', ' ')} -  no change applied.`
                    : `${selDecision.action === 'edited' ? 'Approved with modified edit' : 'Approved'} ${selDecision.ts.slice(0, 16).replace('T', ' ')}${selDecision.via ? `, resolved together with ${selDecision.via}` : ''} -  ${(selDecision.action === 'edited' || selected.res.edit) ? 'fix applied to the working copy below.' : 'verdict confirmed; no content change.'}`}
                </div>
              )}
              {dupCount > 0 && !selDecision && (
                <div className="dup-note">{dupCount} other report{dupCount > 1 ? 's' : ''} on this question propose the identical fix and will be resolved together.</div>
              )}
              {conflict && (
                <div className="conflict">
                  Blocked: field "{conflict.field}" was already patched by {conflict.byReportId} with
                  different content ({JSON.stringify(conflict.existingReplace)} ≠ {JSON.stringify(conflict.attemptedReplace)}).
                  Reject this report, or edit it to match the applied fix.
                </div>
              )}

              <div className="card">
                <h3>Question (rendered, sanitized{selWorking.patchedFields.includes('question') ? ', working copy with applied fix' : ''})</h3>
                <div className="question-render"
                  dangerouslySetInnerHTML={{ __html: sanitizeContentHtml(selWorking.questionHtml) }} />
              </div>

              <div className="card">
                <h3>AI verdict &amp; evidence</h3>
                <div className="evidence">{selected.res.evidence}</div>
                {selected.res.evidence?.includes('injection_attempt') && (
                  <div className="injection">This report contained text aimed at manipulating an AI system. It was ignored; the question was judged on its merits.</div>
                )}
              </div>

              <div className="card">
                <h3>Student reports on this question</h3>
                <div className="reports-list">
                  {data.reports.filter(r => r.questionId === selected.q.id).map(r => (
                    <div className="r" key={r.reportId}><span className="rid">{r.reportId}</span>{r.comment}</div>
                  ))}
                </div>
              </div>

              <div className="card">
                <h3>Proposed edit (before / after){selDecision && selDecision.action !== 'rejected' ? ' -  applied to working copy' : ''}</h3>
                <Diff edit={editing ? draftEdit : selected.res.edit}
                  source={selected.res.edit?.field === 'solution' ? selected.q.solutionText
                    : selected.res.edit?.field === 'question' ? selected.q.stem + '\n' + selected.q.options.map(o => o.text).join('\n')
                    : JSON.stringify(selected.q.storedAnswer)}
                  editing={editing} onChange={setDraftEdit} />
                {selWorking.patchedFields.includes('solution') && (
                  <div className="patched-solution">
                    <div className="field-name">solution (working copy, patch applied):</div>
                    <div className="evidence">{selWorking.solutionText}</div>
                  </div>
                )}
              </div>

              <div className="card">
                <h3>Student reply preview</h3>
                <div className="reply-caption">
                  {selDecision && selDecision.action !== 'rejected'
                    ? (selected.res.edit ? 'Released with the approved fix (recorded in the audit log).'
                       : 'Released with your approval (recorded in the audit log).')
                    : (selected.res.edit ? 'Draft -  goes out only when the fix is approved. Written for the moment the fix is live.'
                       : 'Draft -  goes out only when you approve this response.')}
                </div>
                <div className="bubble"><div className="who">Acadza → student</div>{selected.res.student_reply}</div>
              </div>

              <div className="actions">
                <button className="approve" onClick={() => decide('approved')}>Approve <kbd>a</kbd></button>
                <button className="edit" onClick={() => { setDraftEdit(selected.res.edit); setEditing(!editing) }}>Edit <kbd>e</kbd></button>
                {editing && <button className="approve" onClick={() => decide('edited')}>Approve edited</button>}
                <button className="reject" onClick={() => decide('rejected')}>Reject <kbd>r</kbd></button>
              </div>
            </>
          )}
        </div>
      </main>
    </>
  )
}
