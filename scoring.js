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
  doctrine: 'Your doctrine forbids this kill.',
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

/* ============================================================
   M9 — CLAN STANDING
   ⚠️ THE ONLY PERSISTENT NUMBER IN THE GAME, and it is a ROLLING AVERAGE OF
   YOUR LAST TWENTY TROPHIES (§1). Not a total, not a meter. Ghost of Tsushima
   pointedly shipped a game about a collapsing honor code with NO honor meter,
   because the known failure of karma systems is that players pick a lane in
   hour one and never revisit it. A rolling average always decays, always
   forgives, and always asks again.
   ============================================================ */
export const STANDING_WINDOW = 20;
export function standing(trophies){
  if(!trophies || !trophies.length) return 0;
  const last = trophies.slice(-STANDING_WINDOW);
  return last.reduce((a,t)=>a+(t.score||0),0) / last.length;
}

/* The cloak is EARNED, not bought (Badlands canon, §10). You begin without
   one; it arrives at ELDER as recognition — and from that moment the most
   powerful thing you own is the one that ruins your score. */
export const RANKS = [
  { key:'unblooded', label:'UNBLOODED', at:0,
    note:'You have taken nothing that counts.' },
  { key:'blooded',   label:'BLOODED',   at:110,
    note:'They know your name in the hall.' },
  { key:'hunter',    label:'HUNTER',    at:300,
    note:'You are trusted with the charts.' },
  { key:'elder',     label:'ELDER',     at:640, grants:'cloak',
    note:'The cloak is yours. Using it is the choice they are watching.' },
  { key:'clanlord',  label:'CLAN LORD', at:1150,
    note:'The great hunts are open to you.' }
];
export function rankOf(st){
  let r = RANKS[0];
  for(const k of RANKS) if(st >= k.at) r = k;
  return r;
}
export function nextRank(st){ return RANKS.find(k=>k.at > st) || null; }

/* ============================================================
   M10 — THE FALL
   ⚠️ BAD BLOOD IS A CHAPTER, NOT A FAIL STATE (§11). Sustained dishonour
   drifts you toward outcast: merchants close one at a time, the clan charts
   stop updating, and eventually your own people send someone to collect you —
   mechanically the hardest and highest-scoring quarry in the game. And there
   is always a way back.

   ⚠️ DISGRACE IS NOT "LOW STANDING". A hunter taking small honest quarry has
   low standing and clean hands. What damns you is METHOD: voids, butchery,
   killing what could never reach you. A Contest or a Rite washes it off.
   ============================================================ */
export const DISGRACE_WINDOW = 20;
export const DISGRACE_WEIGHTS = {
  void:      1.00,   // a gravid kill, an overkill, a doctrine broken
  butchery:  0.55,   // it never knew you were there
  culling:   0.16,   // it knew, and could never reach you
  clean:    -0.10,
  closework:-0.40,
  contest:  -0.75,   // it drew your blood and you finished it anyway
  rite:     -1.00    // the perfect form. Nothing washes off faster.
};
/* ⚠️ TAKING ONE OF YOUR OWN IS THE ASSIGNMENT (§11), and it absolves in
   proportion to HOW you took it — a clan hunter shot from under a cloak
   barely counts. This is a WEIGHT, not a padding hack: the first version
   pushed a dozen blank filler trophies onto the shelf to move the average,
   which polluted the wall of skulls with "— undefined 0" rows. The wall is a
   record of every answer you gave; nothing fake goes on it. */
export const CLAN_ABSOLUTION = {
  rite:-15, contest:-14, closework:-10, clean:-6, culling:-3, butchery:-1
};
export function disgrace(trophies){
  if(!trophies || !trophies.length) return 0;
  const last = trophies.slice(-DISGRACE_WINDOW);
  let d = 0;
  for(const t of last){
    if(t.clan && !t.voided) d += (CLAN_ABSOLUTION[t.method] ?? -6);
    else d += t.voided ? DISGRACE_WEIGHTS.void : (DISGRACE_WEIGHTS[t.method] ?? 0);
  }
  return Math.max(0, Math.min(1, d / last.length));
}

export const FALL = [
  { key:'good',    label:'IN GOOD STANDING', at:0,
    note:'Your clan has no complaint with you.' },
  { key:'watched', label:'WATCHED',          at:0.30, closesMerchants:1,
    note:'Word travels. Some keepers have stopped meeting your eye.' },
  /* ⚠️ 0.50, not 0.56: pure butchery scores exactly 0.55, and at 0.56 a hunter
     who had done nothing BUT cloaked kills for twenty trophies sat one
     hundredth short of Outcast. That is a boundary accident, not a design —
     sustained dishonour is supposed to drift you out. */
  { key:'outcast', label:'OUTCAST',          at:0.50, closesMerchants:2, chartsDark:true,
    note:'The charts have stopped updating. You are hunting blind now.' },
  { key:'badblood',label:'BAD BLOOD',        at:0.78, closesMerchants:3, chartsDark:true,
    hunted:true,
    note:'They have sent someone. Cast out and hunted by your own.' }
];
export function fallOf(d){
  let f = FALL[0];
  for(const s of FALL) if(d >= s.at) f = s;
  return f;
}

/* ============================================================
   M7 — THE DOCTRINES
   Four answers to what makes a kill honorable. Each defines its own RITE
   (see RITES above) and its own PROHIBITION — a hard cap, not a scolding.
   ⚠️ A doctrine that only grants bonuses is a class pick. These cost you
   something real, and that is the entire point of picking one.
   ============================================================ */
export const CAP_ORDER = ['butchery','culling','clean','closework','contest','rite'];
export const DOCTRINES = {
  vokaar: { label:'VOKAAR', sub:'The Unshrouded', line:'It must see what kills it.',
    /* the cloak hardware is simply not in their mask */
    noCloak:true, con:1.35, healRate:1.55,
    prohibition:'Anything killed while FLEEING you caps at Clean.',
    cap: c => c.fleeing ? 'clean' : null },
  ssith:  { label:'SSITH', sub:'The Single Edge', line:'Once. Only ever once.',
    opticRange:1.35, con:0.72,
    prohibition:'A SECOND wound on the same quarry voids the trophy entirely.',
    cap: c => c.strikes > 1 ? 'VOID' : null },
  krahn:  { label:'KRAHN', sub:'The Answered', line:'We do not take. We accept.',
    con:1.20,
    prohibition:'No score from a fleeing target, ever.',
    cap: c => c.fleeing ? 'VOID' : null },
  ossun:  { label:'OSSUN', sub:'The Long Patience', line:'Know the life before you end it.',
    senses:1.25, con:0.9,
    prohibition:'Nothing above Clean counts until you have watched a full cycle.',
    cap: c => !c.cycleObserved ? 'clean' : null }
};
export const DOCTRINE_KEYS = Object.keys(DOCTRINES);

/* Lower a grade to a ceiling. Never raises — a cap is a cap. */
export function capMethod(method, cap){
  if(!cap) return method;
  const have = CAP_ORDER.indexOf(method), lim = CAP_ORDER.indexOf(cap);
  return (have > lim && lim >= 0) ? cap : method;
}

/* Apply a doctrine's prohibition to an already-graded kill. Returns either a
   capped method, or a VOID — the doctrine was violated outright. */
export function applyDoctrine(method, ctx){
  const d = DOCTRINES[ctx.doctrine];
  if(!d || !d.cap) return { method, capped:false };
  const cap = d.cap(ctx);
  if(!cap) return { method, capped:false };
  if(cap === 'VOID') return { method, doctrineVoid:true, capped:false };
  const have = CAP_ORDER.indexOf(method), lim = CAP_ORDER.indexOf(cap);
  return { method: have > lim ? cap : method, capped: have > lim };
}

/* ---------- THE RECKONING ---------- */
export function trophyScore(o){
  const voided = voidCheck(o);
  const value  = quarryValue(o.tier, o.specimenPct);
  let   method = o.method || gradeMethod(o);
  /* ⚠️ THE WEAPON CEILING (§10, M8) bites first: the silent, certain thing
     caps every kill you make with it at CULLING, forever. Buying power is
     how you buy your standing down. */
  const beforeWeapon = method;
  method = capMethod(method, o.weaponCap);
  const weaponCapped = method !== beforeWeapon;
  /* ⚠️ the doctrine bites AFTER the beast has decided the grade — it can only
     ever take the kill DOWN, never lift it */
  const doc    = applyDoctrine(method, o);
  method       = doc.method;
  const mult   = METHOD[method].mult;
  const cond   = (o.integrity ?? 1) * (PARTY_MULT[o.party || 1] ?? 1) * (o.doctrineCap ?? 1);
  const rep    = repetitionMult(o.consecutive || 0);
  const dead   = voided || (doc.doctrineVoid ? 'doctrine' : null);
  const score  = dead ? 0 : value * mult * cond * rep;
  return {
    voided: dead,
    /* ⚠️ a doctrine void must name the RULE YOU BROKE, not "your doctrine
       forbids this" — the player has to be able to learn from it */
    voidReason: !dead ? null
      : dead==='doctrine'
        ? (DOCTRINES[o.doctrine]?.prohibition || VOID_REASONS.doctrine)
        : VOID_REASONS[dead],
    value, method, methodLabel: METHOD[method].label, methodMult: mult,
    doctrineCapped: !!doc.capped, weaponCapped,
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
