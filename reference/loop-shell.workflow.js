// loop-shell: reference implementation of the loop-builder governance model
// with the CONTROL FLOW IN DETERMINISTIC CODE, not in agent prose.
//
// This is a runnable Claude Code Workflow script (adapt the same shape to any
// orchestrator that can run agents inside a host-language loop). The point:
//
//   - round counting, budget, stall tripwire (K), distance window (W),
//     supervisor trip, and stop conditions are `if` statements — the executor
//     cannot talk its way past them;
//   - the executor self-reports a classification, but the shell ALSO verifies
//     acceptance distance from the structured criteria status it must return —
//     self-report is used for the cheap trip, never as the only measurement;
//   - the judge sees only {artifact, acceptance spec}, never the execution
//     transcript — information asymmetry enforced by construction;
//   - the final acceptance check re-runs independently, and the loop can end
//     only through the three legal exits (done / abandoned / exhausted).
//
// Charter values (budget, K, W, criteria) come from the acceptance co-design
// step of SKILL.md; pass them via `args`. State externalization still belongs
// to ACH (https://github.com/bagbag16/agent-continuity-harness): checkpoint
// each round's ledger entry into the bound state root from inside the stages.

export const meta = {
  name: 'loop-shell',
  description: 'Deterministic governance shell for an autonomous loop (loop-builder reference)',
  phases: [
    { title: 'Execute', detail: 'one bounded attempt per round' },
    { title: 'Judge', detail: 'artifact + spec only, adversarial' },
    { title: 'Accept', detail: 'independent final acceptance' },
  ],
}

const charter = args || {}
const GOAL = charter.goal || 'unset goal'
const CRITERIA = charter.criteria || []       // [{id, statement, necessity: 'P0'|'P1'|'P2'}]
const RED_LINES = charter.redLines || []      // hard boundaries, never tradable
const MAX_ROUNDS = charter.maxRounds || 15    // budget, main unit: rounds
const K = charter.stallTrips || 3             // consecutive self-reported stalls -> trip
const W = charter.distanceWindow || 5         // rounds with no distance decrease -> trip

const ATTEMPT = {
  type: 'object',
  properties: {
    classification: { enum: ['advance', 'stall', 'regress', 'blocked', 'claims_done', 'exhausted'] },
    action_taken: { type: 'string' },
    evidence: { type: 'string' },
    criteria_status: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, met: { type: 'boolean' }, evidence: { type: 'string' } },
        required: ['id', 'met'],
      },
    },
  },
  required: ['classification', 'action_taken', 'evidence', 'criteria_status'],
}

const VERDICT = {
  type: 'object',
  properties: {
    p0_all_met: { type: 'boolean' },
    failed_criteria: { type: 'array', items: { type: 'string' } },
    reasoning: { type: 'string' },
  },
  required: ['p0_all_met', 'failed_criteria'],
}

function unmetP0Count(criteriaStatus) {
  const p0 = new Set(CRITERIA.filter(c => c.necessity === 'P0').map(c => c.id))
  let unmet = 0
  for (const id of p0) {
    const entry = (criteriaStatus || []).find(s => s.id === id)
    if (!entry || !entry.met) unmet += 1
  }
  return unmet
}

let stallStreak = 0
let bestDistance = Infinity
let roundsSinceImprovement = 0
let outcome = null
const ledger = []

phase('Execute')
for (let round = 1; round <= MAX_ROUNDS; round++) {
  const attempt = await agent(
    `You are the loop executor. Goal: ${GOAL}\n` +
    `Red lines (never cross): ${JSON.stringify(RED_LINES)}\n` +
    `Acceptance criteria: ${JSON.stringify(CRITERIA)}\n` +
    `Prior ledger (yours, for context): ${JSON.stringify(ledger.slice(-3))}\n` +
    `Take ONE smallest useful action toward the goal, observe the result, ` +
    `and report honestly. For criteria_status, test each criterion for real — ` +
    `do not mark met without evidence.`,
    { label: `round-${round}`, phase: 'Execute', schema: ATTEMPT },
  )
  if (!attempt) { outcome = { exit: 'exhausted', reason: 'executor died' }; break }

  // ---- supervision is code, not opinion -------------------------------
  const distance = unmetP0Count(attempt.criteria_status)   // independent measure
  ledger.push({ round, classification: attempt.classification, distance, action: attempt.action_taken })
  log(`round ${round}: ${attempt.classification}, unmet P0 = ${distance}`)

  // cheap trip: trust the self-label only to STOP EARLIER, never to continue
  stallStreak = attempt.classification === 'stall' ? stallStreak + 1 : 0
  if (stallStreak >= K) { outcome = { exit: 'tripped', reason: `${K} consecutive stalls` }; break }

  // core trip: measured distance, immune to progress theater
  if (distance < bestDistance) { bestDistance = distance; roundsSinceImprovement = 0 }
  else if (++roundsSinceImprovement >= W) { outcome = { exit: 'tripped', reason: `no P0 progress in ${W} rounds` }; break }

  if (attempt.classification === 'blocked') { outcome = { exit: 'abandoned', reason: attempt.evidence }; break }

  if (attempt.classification === 'claims_done' || distance === 0) {
    // executor only TRIGGERS acceptance; it never rules on it
    phase('Judge')
    const verdict = await agent(
      `You are an adversarial acceptance judge. You see ONLY the acceptance ` +
      `spec and the artifact evidence — no execution history, by design.\n` +
      `Spec: ${JSON.stringify(CRITERIA)}\nEvidence: ${attempt.evidence}\n` +
      `Assume unmet until proven. Which criteria actually fail?`,
      { label: `judge-${round}`, phase: 'Judge', schema: VERDICT },
    )
    if (verdict && verdict.p0_all_met) { outcome = { exit: 'done', round }; break }
    log(`judge rejected: ${(verdict && verdict.failed_criteria || []).join(', ')}`)
    phase('Execute') // back to work; the rejection is the next round's input
  }
}
if (!outcome) outcome = { exit: 'exhausted', reason: `budget of ${MAX_ROUNDS} rounds spent` }

// ---- the three legal exits, always with an explicit account -------------
phase('Accept')
const closing = await agent(
  `You are the acceptance owner. The loop ended: ${JSON.stringify(outcome)}.\n` +
  `Ledger: ${JSON.stringify(ledger)}\nCriteria: ${JSON.stringify(CRITERIA)}\n` +
  `Produce the closing statement: which criteria are met/unmet, what was ` +
  `sacrificed (P1/P2 gaps must be listed explicitly, never silently dropped), ` +
  `and — if not done — what is blocking and what the next charter should say.`,
  { label: 'closing', phase: 'Accept' },
)

return { outcome, ledger, closing }
