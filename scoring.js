/* ============================================================
   QUARRY — scoring.js   (M2, THE RECKONING)

   TROPHY SCORE = QUARRY VALUE x METHOD MULTIPLIER x CONDITION x REPETITION

   ⚠️ EVERY NUMBER IN THIS FILE IS SOLVER OUTPUT. Do not hand-tune it.
   The tiers, the method multipliers and the approach distributions came out
   of `tools/solve-scoring.py` against seven constraints, and the line that
   matters is `axis balance 1.000` — the log-range of quarry values and of
   method multipliers are identical, so neither axis can dominate the other.
   To change balance, change the CONSTRAINTS in the solver and re-run it.

   Pure functions only. No state, no rng, no DOM. sim.js owns the state and
   feeds it in; test-sim.mjs hits these directly.
   ============================================================ */

/* ---------- QUARRY VALUE ----------
   Tier is a population consequence, not a loot roll: apex predators are rare
   because energy thins as it climbs the food web (trophic pyramids, §5). */
export const TIERS = {
  common:    { label:'COMMON',    value:100 },
  uncommon:  { label:'UNCOMMON',  value:170 },
  epic:      { label:'EPIC',      value:289 },
  legendary: { label:'LEGENDARY', value:491 }
};

export const BANDS = [
  { key:'named',        label:'THE NAMED',    min:1.30 },
  { key:'paragon',      label:'PARAGON',      min:0.90 },
  { key:'prime',        label:'PRIME',        min:0.60 },
  { key:'notable',      label:'NOTABLE',      min:0.20 },
  { key:'unremarkable', label:'UNREMARKABLE', min:-1   }
];
export function bandOf(pct){
  for(const b of BANDS) if(pct >= b.min) return b;
  return BANDS[BANDS.length-1];
}

export function quarryValue(tierKey, specimenPct){
  const t = TIERS[tierKey] || TIERS.common;
  return t.value * (0.40 + specimenPct * 1.50);
}

/* ---------- METHOD ----------
   ⚠️ YOU DO NOT CHOOSE THIS. You choose an APPROACH; the beast decides the
   grade (§5). Modelling Rite as a player choice produced either dead content
   or total dominance — both modelling errors, because you cannot choose to be
   charged. Everything below is READ off what actually happened. */
export const METHOD = {
  butchery:  { label:'BUTCHERY',    mult:0.20,
               note:'It never knew you were there. Anyone can do this.' },
  culling:   { label:'CULLING',     mult:0.56,
               note:'It knew. It could never have reached you.' },
  clean:     { label:'CLEAN',       mult:1.00,
               note:'Uncloaked, aware, honest range.' },
  closework: { label:'CLOSE WORK',  mult:2.36,
               note:'You went inside its reach.' },
  contest:   { label:'THE CONTEST', mult:3.64,
               note:'It drew your blood first, and you finished it anyway.' },
  rite:      { label:'RITE',        mult:5.00,
               note:'The perfect form of your doctrine.' }
};

/* The four doctrines' perfect forms (§7). The DATA lands here in M2 because
   M2's acceptance test cannot run without a reachable Rite — M7 adds the
   selection UI and the prohibitions on top of this. */
export const RITES = {
  vokaar: { label:'VOKAAR', line:'It must see what kills it.',
    /* the beast charges and you meet it without giving ground */
    test: c => c.wasCharging && !c.gaveGround && !c.cloaked },
  ssith:  { label:'SSITH', line:'Once. Only ever once.',
    /* one strike, at close work, and it dies of that strike alone */
    test: c => c.strikes === 1 && c.insideReach && !c.cloaked },
  krahn:  { label:'KRAHN', line:'We do not take. We accept.',
    /* the quarry initiated and never tried to disengage */
    test: c => c.quarryInitiated && !c.quarryDisengaged && !c.cloaked },
  ossun:  { label:'OSSUN', line:'Know the life before you end it.',
    /* a full feeding cycle observed, then taken at close work in its bed */
    test: c => c.cycleObserved && c.insideReach && c.inBeddingGround && !c.cloaked }
};

/* Grade the kill from what the sim actually recorded.
   ctx: {cloaked, everAware, dist, reach, engageRange, drewBlood, thrown,
         wasCharging, gaveGround, strikes, quarryInitiated, quarryDisengaged,
         cycleObserved, inBeddingGround, doctrine} */
export function gradeMethod(ctx){
  const insideReach = ctx.dist <= ctx.reach;
  const c = {...ctx, insideReach};

  /* RITE first — it is the only grade that can override the others, and only
     the beast's own behaviour can produce it. */
  const rite = ctx.doctrine && RITES[ctx.doctrine];
  if(rite && rite.test(c)) return 'rite';

  /* Hidden the whole way, or it never knew: butchery, whatever the range. */
  if(ctx.cloaked || !ctx.everAware) return 'butchery';

  if(insideReach && ctx.thrown){
    return ctx.drewBlood ? 'contest' : 'closework';
  }
  /* aware, but killed from beyond anything it could have closed */
  if(ctx.dist > ctx.engageRange) return 'culling';
  return 'clean';
}

/* ---------- CONDITION ---------- */
/* A skull shot ruins the trophy (§3 — you read the body, there is no health bar) */
export const INTEGRITY = { clean:1.00, bodyDamage:0.88, skull:0.55 };

export const PARTY_MULT = { 1:1.15, 2:1.00, 3:0.90 };

/* DMC's answer to "players pick a lane": repeating the same approach on the
   same species decays, and SWITCHING RESETS IT. Verified in the solver — on
   Epic quarry the optimum shifts by the second consecutive repeat. */
export const REPEAT_DECAY = 0.82;
export function repetitionMult(consecutive){
  return Math.pow(REPEAT_DECAY, Math.max(0, consecutive));
}

/* ---------- THE VOID — score zero, and recorded ---------- */
export const VOID_REASONS = {
  gravid:   'You killed a gravid female. The pheromone optic exists. You were told.',
  young:    'You killed the young.',
  noThreat: 'It could not have harmed you. That is not a hunt.',
  overkill: 'You went on striking a dead thing.',
  scavenged:'Something else finished your quarry.',
  witnessed:'You were witnessed by the unworthy and did not correct it.'
};
export function voidCheck(ctx){
  if(ctx.gravid)     return 'gravid';
  if(ctx.young)      return 'young';
  if(ctx.noThreat)   return 'noThreat';
  if(ctx.overkill)   return 'overkill';
  if(ctx.scavenged)  return 'scavenged';
  if(ctx.witnessed)  return 'witnessed';
  return null;
}

/* ---------- THE RECKONING ---------- */
export function trophyScore(o){
  const voided = voidCheck(o);
  const value  = quarryValue(o.tier, o.specimenPct);
  const method = o.method || gradeMethod(o);
  const mult   = METHOD[method].mult;
  const cond   = (o.integrity ?? 1) * (PARTY_MULT[o.party || 1] ?? 1) * (o.doctrineCap ?? 1);
  const rep    = repetitionMult(o.consecutive || 0);
  const score  = voided ? 0 : value * mult * cond * rep;
  return {
    voided, voidReason: voided ? VOID_REASONS[voided] : null,
    value, method, methodLabel: METHOD[method].label, methodMult: mult,
    band: bandOf(o.specimenPct), condition: cond, repetition: rep,
    score: Math.round(score)
  };
}

/* ---------- BOUNTY — the OTHER currency, and it pulls the other way ----------
   Paid for the carcass, scaling with the beast and how INTACT it is. A long,
   close, bloody fight ruins it. Same actions, opposite directions (§6): the
   cloaked kill is simultaneously the best money and the worst standing, at
   every tier. The Void does not zero bounty — a butcher still gets paid, which
   is exactly why honor has to be worth something on its own. */
export const BOUNTY_BASE = 0.62;
export const BOUNTY_BY_METHOD = {
  butchery:1.00, culling:0.72, clean:0.46, closework:0.24, contest:0.16, rite:0.14
};
export function bountyValue(o){
  const value = quarryValue(o.tier, o.specimenPct);
  return Math.round(value * BOUNTY_BASE
    * (BOUNTY_BY_METHOD[o.method || 'clean'])
    * (o.integrity ?? 1));
}
