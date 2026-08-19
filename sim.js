/* ============================================================
   QUARRY — sim.js
   The ENTIRE deterministic simulation. No THREE, no DOM, no rendering.
   Everything here must be reproducible from a seed so it can be soaked
   headlessly (see test-sim.mjs) and, later, lockstepped for co-op.

   INVARIANT: never Math.random() in this file. Use rng from makeRNG().
   ============================================================ */

import { trophyScore, bountyValue, gradeMethod, INTEGRITY, TIERS,
         standing, rankOf, RANKS, DOCTRINES,
         disgrace, fallOf } from './scoring.js';
import { weaponCap } from './market.js';
import { colonyFor, KINDS, seenBy, validityOf,
         ALARM_RADIUS, ENGAGE_RANGE, SHOOT_CD, WITNESS_GRACE, WITNESS_BREAK }
  from './worthy.js';
export * from './market.js';
export * from './worthy.js';
import { generateWorld, nameTheNamed, LAWS, BIOMES, ROLES, LOCOMOTION }
  from './worldgen.js';
export * from './scoring.js';
export * from './worldgen.js';

/* ---------- seeded RNG (LCG, same shape as Age of Toys) ----------
   save()/load() expose the cursor so a save file can restore the stream
   exactly. Without it nothing that happens after a load is reproducible. */
export function makeRNG(seed){
  let s = seed >>> 0;
  const f = function(){ s = (s*1664525 + 1013904223) >>> 0; return s/4294967296; };
  /* ⚠️ WARM THE STREAM. The first output of this LCG is very nearly linear in
     the seed — one step multiplies the seed difference by 1664525, which is
     tiny against 2^32, so seeds n and n+1 produce almost the SAME first draw.
     Anything that seeds sequentially and then tests one probability off draw
     #1 gets garbage: a 6% legendary-world chance measured 26% across 400
     sequential seeds until this warmup went in. Two steps decorrelates; six
     is free. */
  for(let i=0;i<6;i++) f();
  f.save = () => s;
  f.load = v => { s = v >>> 0; };
  return f;
}

/* ---------- seeded value noise ---------- */
export function makeNoise(rng){
  const perm = new Uint8Array(512);
  const p = new Uint8Array(256);
  for(let i=0;i<256;i++) p[i]=i;
  for(let i=255;i>0;i--){ const j=Math.floor(rng()*(i+1)); const t=p[i];p[i]=p[j];p[j]=t; }
  for(let i=0;i<512;i++) perm[i]=p[i&255];
  const fade = t => t*t*t*(t*(t*6-15)+10);
  const grad = (h,x,y) => { switch(h&3){case 0:return x+y;case 1:return -x+y;
                            case 2:return x-y;default:return -x-y;} };
  function noise2(x,y){
    const X=Math.floor(x)&255, Y=Math.floor(y)&255;
    x-=Math.floor(x); y-=Math.floor(y);
    const u=fade(x), v=fade(y);
    const A=perm[X]+Y, B=perm[X+1]+Y;
    return (1-v)*((1-u)*grad(perm[A],x,y)+u*grad(perm[B],x-1,y))
         +  v   *((1-u)*grad(perm[A+1],x,y-1)+u*grad(perm[B+1],x-1,y-1));
  }
  function fbm(x,y,oct=4){
    let v=0,a=1,f=1,n=0;
    for(let i=0;i<oct;i++){ v+=noise2(x*f,y*f)*a; n+=a; a*=0.5; f*=2.02; }
    return v/n;
  }
  return {noise2, fbm};
}

/* ============================================================
   SENSORY PROFILES
   Every creature perceives on all three channels. What differs is the
   WEIGHTING - and that is what makes one hunt different from the last.

   `threat` is first-class: how much fight the animal has in it when it has
   finally had enough of you. COTW's own forums record "the bison used to
   charge you earlier, not anymore, they just flee" as the moment that game
   stopped being interesting. Nothing here only flees.
   ============================================================ */
export const PROFILES = {
  watcher: { label:'Watcher',
    sight:1.00, sound:0.35, scent:0.30, threat:0.45,
    fov:2.30, peripheral:2.95, sightRange:95, hearRange:38, note:
    'Wide-eyed open-ground grazer. Cover and stillness are everything; wind barely matters.' },
  nose: { label:'Nose',
    sight:0.30, sound:0.55, scent:1.00, threat:0.40,
    fov:1.10, peripheral:1.90, sightRange:34, hearRange:44, note:
    'Wind discipline IS the hunt. You can stand in the open upwind of it.' },
  listener: { label:'Listener',
    sight:0.30, sound:1.00, scent:0.60, threat:0.35,
    fov:1.20, peripheral:2.10, sightRange:30, hearRange:78, note:
    'Substrate choice dominates. Shale betrays you; moss forgives you.' },
  balanced: { label:'Balanced',
    sight:0.70, sound:0.70, scent:0.70, threat:0.50,
    fov:1.75, peripheral:2.55, sightRange:62, hearRange:52, note:
    'The teaching quarry. Everything matters a little, nothing dominates.' },
  ambusher: { label:'Ambusher',
    sight:1.00, sound:1.00, scent:0.35, threat:0.90,
    fov:1.55, peripheral:2.30, sightRange:31, hearRange:30, note:
    'Lethal inside 30m, near-blind past it. Distance is safety.' },
  blindhunter: { label:'Blind-hunter',
    sight:0.00, sound:1.00, scent:1.00, threat:0.85,
    fov:0, peripheral:0, sightRange:0, hearRange:70, note:
    'No eyes at all. RARE - a legendary profile, not a common one.' }
};

/* ============================================================
   SPECIES
   ⚠️ SPECIES ARE GENERATED PER WORLD NOW (M4). There is no global roster —
   `sim.species` is this world's, produced by worldgen.js under this world's
   LAW. Anything that needs a species def must read it off the sim, because
   the same key means a different animal on the next rock.
   Tier rarity is a POPULATION consequence (trophic pyramid, §5), and the
   per-world counts live in `sim.wgen.population`. */

/* Monster Hunter's crowns: ~36 discrete buckets, skewed so that ordinary
   hunting rolls a Paragon rarely (~5%) but hunting FOR one pays off. */
export const SPECIMEN_BUCKETS = 36;
export const NAMED_PCT = 1.60;
export function rollSpecimen(rng, namedChance){
  if(rng() < namedChance) return NAMED_PCT;
  const skewed = Math.pow(rng(), 1.9);
  return Math.round(skewed*SPECIMEN_BUCKETS)/SPECIMEN_BUCKETS;
}

/* ============================================================
   WORLD
   ============================================================ */
export const WORLD_SIZE = 220;
export const GRID = 160;
export const WATER_Y = 1.15;
export const DAY_REAL_MIN = 90;
export const DAY_SEC = DAY_REAL_MIN*60;

export const PHASES = [
  ['DEEP NIGHT',0,4],['DAWN',4,7],['MORNING',7,11],['MIDDAY',11,15],
  ['AFTERNOON',15,18],['DUSK',18,21],['NIGHT',21,24]
];

/* Awareness tuning. These three numbers set the entire feel of a stalk.
   STIM_FLOOR : below this, a stimulus is beneath notice and awareness drains.
   RISE_RATE  : awareness gained per second at stimulus 1.0.
   DECAY_RATE : awareness lost per second with no stimulus.
   At stim 0.28 (a loud player at ~6m): ALERT in ~1.8s, SPOOKED in ~4.3s,
   and full calm ~7.8s after you break contact. */
export const STIM_FLOOR = 0.05;
export const RISE_RATE  = 0.55;
export const DECAY_RATE = 0.085;
export const ALERT_AT   = 0.28;
export const SPOOK_AT   = 0.66;

/* ============================================================
   THE WOUND (bible S4) — losing does not rewind anything.
   You wake on the ship, injured, and the beast keeps a piece of your kit
   and stays on this world carrying it. Failure is the world taking a
   trophy from YOU.
   ============================================================ */

/* The charge. Three spooks and it leaves - but if you crowded it, it leaves
   THROUGH you. Two prior spooks and a SPOOKED readout are the tell:
   greed, never ambush (invariant 7). It commits to a heading and only
   corrects slowly, so a lateral break genuinely works. */
export const CHARGE_RANGE = 19;    // it only turns on you if you are this close
export const CHARGE_SPEED = 9.5;
export const CHARGE_TURN  = 0.42;  // rad/s of correction once committed
export const CHARGE_COMMIT= 7.0;   // inside this range the correction fades out
export const CHARGE_MAX   = 5.0;   // seconds before it gives up and goes
export const CONTACT_R    = 2.4;
export const OBSERVE_RANGE= 70;    // close enough (with LOS) to be OBSERVING it
export const GROUND_GIVEN = 2.0;   // metres of retreat that count as giving ground

/* ============================================================
   LOCATED WOUNDS (§3) — the half of the hunt that was missing.
   "No health bars, ever. Wounds are located and simulated. A leg changes
   gait and shortens flight. You read the body."

   ⚠️ NOT EVERY HIT KILLS, and that is the entire tracking game. Skull and
   vitals drop it where it stands. A GUT hit starts a long bleed — dark,
   sparse blood, and the beast dies somewhere ahead of you. A LEG hit
   cripples it: it survives, clots, and remembers you.
   The trophy is graded AT THE WOUND that proves mortal, and you only bank
   it when you FIND the carcass — lose the trail, or let a scavenger reach
   it first, and §5's void applies: something else finished your quarry.
   ============================================================ */
export const WOUNDS = {
  gut: { bleed:0.010, sev:0.55,
         tell:'DARK BLOOD — THIS WILL TAKE TIME' },
  leg: { bleed:0.0035, sev:1.0, clotAt:0.62, cripple:0.55,
         tell:'ITS LEG — IT CANNOT RUN FAR NOW' }
};
export const BED_AT    = 0.35;  // blood fraction at which it lies down
export const BED_DIE_T = 45;    // seconds bedded before it dies
export const BLOOD_MAX = 240;   // blood-sign cap
export const CLAIM_R   = 3.0;   // walk up to the carcass to claim it
export const SCAVENGE_LOSS = 25;// seconds of feeding before the trophy is gone

/* ⚠️ TWO TIERS: BLEEDING, THEN BROKEN (Kyle, 2026-08-11).
   The first strike does NOT end the hunt. It opens you up: you bleed, you are
   louder and slower, and the beast stays and is now in a fight with you. A
   SECOND strike while bleeding is what breaks you.
   This is what makes THE CONTEST (x3.64) and RITE (x5.00) reachable at all -
   both require the beast to have drawn your blood and you to have kept
   hunting. With a single wound tier the top half of the score table was
   unreachable by construction. */
export const BLEED_HOURS = 1.6;    // in-world hours before it closes on its own
export const BLEED_NOISE = 0.40;
export const BLEED_SPEED = 0.84;

/* Injuries STACK (severity 1-3) and heal over in-world days. Every one of
   them is mechanical - none is a debuff icon with no teeth. */
export const INJURIES = {
  ribs: { label:'CRACKED RIBS',  days:2.0, noise:0.30,
          note:'Every breath is loud. Stillness costs you now.' },
  leg:  { label:'TORN LEG',      days:2.6, noise:0.22, speed:-0.26,
          note:'You limp. Slower, and you cannot move quietly.' },
  eye:  { label:'RUINED EYE',    days:3.4, optic:1,
          note:'One lens will not focus. Read the world with the others.' },
  gut:  { label:'DEEP GUT WOUND',days:4.0, con:-0.40,
          note:'You are bleeding inside. You will not take the next one well.' },
  hand: { label:'BROKEN HAND',   days:2.2, throwErr:0.10,
          note:'The spear does not fly where you are looking.' }
};
export const INJURY_KEYS = Object.keys(INJURIES);

export const KIT = {
  spears:    { label:'THROWING SPEARS', taken:'It ran off with your spears.' },
  blade:     { label:'WRIST BLADE',     taken:'It tore the blade off your arm.' },
  thermal:   { label:'THERMAL OPTIC',   taken:'The thermal lens went with it.' },
  pheromone: { label:'PHEROMONE OPTIC', taken:'Your scent-reader is gone.' },
  cloak:     { label:'THE CLOAK',       taken:'It took the cloak. You are visible now.' }
};
/* ⚠️ spears are NOT in the take pool. Take a hunter's last means of killing
   and the world becomes unwinnable rather than harder. */
export const KIT_TAKEABLE = ['thermal','pheromone','blade','cloak'];

export function createWorld(seed){
  const rng = makeRNG(seed);
  const {fbm} = makeNoise(rng);
  const heights = new Float32Array(GRID*GRID);

  /* ⚠️ THE LANDFORM IS PER-WORLD NOW. The basin and the ridge used to be
     HARDCODED — every world in an "endless universe" was the same land with
     different bumps: lake always at (0.30, 0.68), ridge always on the same
     diagonal. Macro structure is drawn from the world's own rng: where the
     water is, which way the high ground runs, whether there is a second
     crest or a mound. Worlds have different SHAPES now, not just different
     noise. (This shifts the rng stream — a deliberate one-time break.) */
  const M = {
    bx: 0.22+rng()*0.56, by: 0.22+rng()*0.56,
    bdepth: 5.8+rng()*2.0, bwide: 8+rng()*6,
    ra: rng()*Math.PI, rc: 0.35+rng()*0.5,
    ramp: 3.2+rng()*1.3, rwide: 90+rng()*120,
    ridge2: rng()<0.5, r2a: rng()*Math.PI, r2c: 0.30+rng()*0.6,
    r2amp: 2.0+rng()*1.4, r2wide: 90+rng()*140,
    mound: rng()<0.6, mx: 0.25+rng()*0.5, my: 0.25+rng()*0.5,
    mamp: 1.2+rng()*2.0
  };
  const rca=Math.cos(M.ra), rsa=Math.sin(M.ra);
  const r2ca=Math.cos(M.r2a), r2sa=Math.sin(M.r2a);

  function genHeight(i,j){
    const x=i/GRID, y=j/GRID;
    let h = fbm(x*2.4, y*2.4, 5)*7.0;
    h += fbm(x*6.1+11.3, y*6.1-4.7, 3)*1.7;
    const dx=x-M.bx, dy=y-M.by;
    h -= Math.exp(-(dx*dx+dy*dy)*M.bwide)*M.bdepth;   // basin -> water
    const rd = Math.abs(x*rca + y*rsa - M.rc);
    h += Math.exp(-rd*rd*M.rwide)*M.ramp;             // ridge -> cover & vantage
    if(M.ridge2){
      const r2 = Math.abs(x*r2ca + y*r2sa - M.r2c);
      h += Math.exp(-r2*r2*M.r2wide)*M.r2amp;
    }
    if(M.mound){
      const mx=x-M.mx, my=y-M.my;
      h += Math.exp(-(mx*mx+my*my)*26)*M.mamp;
    }
    return h+3.0;
  }
  for(let j=0;j<GRID;j++) for(let i=0;i<GRID;i++) heights[j*GRID+i]=genHeight(i,j);

  /* ⚠️ THE ZONE GUARANTEES ARE NON-NEGOTIABLE. findZone falls back to an
     arbitrary sample when its predicate never matches, so a world with no
     shoreline gets a "water zone" on dry land and the whole schedule game
     silently rots. Enforce by construction: SOMEWHERE must be underwater,
     and SOMEWHERE must be bed-height. Deterministic post-fix, not a reroll. */
  {
    /* ⚠️ only the INTERIOR counts — findZone samples ±0.4·WORLD, so a crest
       raised in the outer margin satisfies the max and helps nobody. 6 of 50
       seeds shipped bed zones at y=-2 that way. */
    let min=1e9,max=-1e9,argMax=0,argMin=0;
    const lo=(GRID*0.14)|0, hi=(GRID*0.86)|0;
    for(let j=lo;j<hi;j++) for(let i=lo;i<hi;i++){
      const k=j*GRID+i;
      if(heights[k]<min){min=heights[k];argMin=k;}
      if(heights[k]>max){max=heights[k];argMax=k;}
    }
    if(min > WATER_Y-0.5){          // no real water: deepen the basin
      const need=(min-(WATER_Y-0.5)), ci=argMin%GRID, cj=(argMin/GRID)|0;
      for(let j=0;j<GRID;j++) for(let i=0;i<GRID;i++){
        const dx=(i-ci)/GRID, dy=(j-cj)/GRID;
        heights[j*GRID+i] -= Math.exp(-(dx*dx+dy*dy)*10)*(need+0.8);
      }
    }
    if(max < 6.6){                   // no high ground: raise the crest
      const need=6.9-max, ci=argMax%GRID, cj=(argMax/GRID)|0;
      for(let j=0;j<GRID;j++) for(let i=0;i<GRID;i++){
        const dx=(i-ci)/GRID, dy=(j-cj)/GRID;
        heights[j*GRID+i] += Math.exp(-(dx*dx+dy*dy)*30)*need;
      }
    }
  }

  function heightAt(wx,wz){
    const fx=(wx/WORLD_SIZE+0.5)*(GRID-1), fz=(wz/WORLD_SIZE+0.5)*(GRID-1);
    const i=Math.floor(fx), j=Math.floor(fz);
    if(i<0||j<0||i>=GRID-1||j>=GRID-1) return 3.0;
    const tx=fx-i, tz=fz-j;
    const h00=heights[j*GRID+i], h10=heights[j*GRID+i+1];
    const h01=heights[(j+1)*GRID+i], h11=heights[(j+1)*GRID+i+1];
    return (h00*(1-tx)+h10*tx)*(1-tz) + (h01*(1-tx)+h11*tx)*tz;
  }
  /* 0 = soft loam (quiet)   1 = shale (loud) */
  function substrateAt(wx,wz){
    return Math.min(1,Math.max(0, fbm(wx*0.035+50, wz*0.035-20, 2)*1.6+0.5));
  }
  /* 0 = bare   1 = deep cover. Hides you from SIGHT. */
  function coverAt(wx,wz){
    const y=heightAt(wx,wz);
    if(y<WATER_Y+0.25) return 0;
    return Math.min(1,Math.max(0, fbm(wx*0.05+7, wz*0.05-3, 3)*0.5+0.5));
  }
  /* line of sight: sample terrain between two points */
  function hasLOS(ax,ay,az,bx,by,bz){
    const steps=14;
    for(let k=1;k<steps;k++){
      const t=k/steps;
      const x=ax+(bx-ax)*t, z=az+(bz-az)*t, y=ay+(by-ay)*t;
      if(heightAt(x,z) > y+0.35) return false;
    }
    return true;
  }
  function findZone(pred, tries=900){
    let best=null,bs=-1e9;
    for(let k=0;k<tries;k++){
      const x=(rng()-0.5)*WORLD_SIZE*0.8, z=(rng()-0.5)*WORLD_SIZE*0.8;
      const y=heightAt(x,z), s=pred(x,z,y,fbm);
      if(s>bs){ bs=s; best={x,z,y}; }
    }
    return best;
  }
  const zones = {
    water: findZone((x,z,y)=> y>WATER_Y+0.15 && y<WATER_Y+0.9 ? 10-y : -100),
    feed : findZone((x,z,y,f)=> y>WATER_Y+1.2 && y<6 ? f(x*0.05+7,z*0.05-3,3) : -100),
    bed  : findZone((x,z,y)=> y>6.2 ? y : -100)
  };
  return {rng, fbm, heights, heightAt, substrateAt, coverAt, hasLOS, zones};
}

/* ============================================================
   THE SIM
   ============================================================ */
export function createSim(seed, profileKey='balanced', groundKey=null){
  const world = createWorld(seed);

  /* ⚠️ THE LAW gets its OWN rng stream, derived from the seed but separate
     from the terrain's. Otherwise every tweak to heightmap code silently
     rerolls the entire biosphere, and a world you learned stops being the
     world you learned — which is the one thing §9 promises never happens.
     M13: `groundKey` swaps the rolled biosphere for an AUTHORED one. */
  const wgen = generateWorld(seed, makeRNG((seed ^ 0x5eed1) >>> 0), groundKey);
  const speciesTable = {};
  for(const s of wgen.species) speciesTable[s.key] = s;
  const firstGrazer = wgen.species.find(s=>s.role==='grazer') || wgen.species[0];

  /* the LAW can override the quarry's own senses — but only a LEGENDARY law
     is allowed to delete one (§8) */
  const prof  = wgen.law==='eyeless' ? PROFILES.blindhunter
              : (PROFILES[profileKey] || PROFILES.balanced);

  const sim = {
    world, prof, profileKey,
    seed,
    simSec: 4.4/24*DAY_SEC,
    wind: { dir: world.rng()*Math.PI*2, targetDir: world.rng()*Math.PI*2,
            strength:0.45, t:0 },
    player: {
      x: world.zones.bed.x, z: world.zones.bed.z, yaw:0,
      moving:false, crouch:false, slow:false, noise:0, scentStrength:1.0,
      cloaked:false, spears:3
    },
    Q: {
      x: world.zones.feed.x+6, z: world.zones.feed.z+6, facing: world.rng()*6.28,
      state:'GRAZE', stateT:0, awareness:0, alertState:'CALM',
      speed:0, alive:true, spooks:0, gone:false, riseFilter:0, lastPrint:0,
      lastChannel:'—',
      /* nemesis state: what it took off you, and how well it knows you now */
      carrying:null, wary:0, charging:false, chargeAim:0,
      /* set when this beast has opened you up. THE CONTEST reads this. */
      drewBlood:false,
      /* --- THE RECKONING reads all of the below off what actually happened.
             You never choose a grade; these are the record of the hunt. --- */
      species:firstGrazer.key, tier:firstGrazer.tier,
      specimenPct:0, gravid:false,
      everAware:false,        // did it ever know something was out there
      strikes:0,              // SSITH's rite needs exactly one
      quarryInitiated:false,  // it started it (KRAHN)
      quarryDisengaged:false, // ...and then tried to leave
      cycleSeen:{},           // OSSUN: feed / drink / bed, observed
      assessed:false,         // have you read it through an optic yet
      /* located wounds: blood is vitality 1→0; wound carries the pending
         reckoning, graded at the moment the mortal hit landed */
      blood:1, bleedRate:0, wound:null, dieT:0, lastBlood:0
    },
    /* THE HUNTER — the only thing that persists across a failed hunt.
       You begin WITHOUT a cloak in the fiction (Badlands: it is earned);
       M1 hands you one so the "using it costs you" lever is playable. */
    hunter: {
      /* ⚠️ NO CLOAK. You begin without one (Badlands canon, §10) — it is
         granted at ELDER as recognition. That is what makes the early game
         teach wind and stillness instead of handing you the crutch first. */
      kit:{ spears:true, blade:true, thermal:true, pheromone:true, cloak:false },
      standing:0, everHadCloak:false,
      /* M8: one primary plus your blades. Swapping means going to the ship. */
      primary:'spears', gear:{}, badBlood:false,
      /* M10 — THE FALL. `disgrace` is method-driven, not score-driven. */
      disgrace:0, fall:'good', clanKills:0, redemption:null,
      witnessed:false, colonistKills:0,
      injuries:{}, breaks:0, scars:0, scarCredit:0, lastBreak:null, taken:[],
      bleed:0,          // seconds of open wound remaining
      bleeds:0,         // how many times you have been opened up
      pendingLoss:null, // {options:[...]} - YOU choose what it keeps
      /* --- the two currencies, and the record (§6) --- */
      doctrine:'vokaar',   // M7 lets you pick; M2 needs one to exist
      honor:0, bounty:0, trophies:[], voids:0,
      gaveGround:false,    // did you give ground while it was coming
      /* DMC repetition: same approach on the same species decays, and
         switching resets it. Keyed by species. */
      lastApproach:{}, approachRun:{}
    },
    tracks: [],
    blood: [],                 // the other kind of sign: {x,z,age,sev}
    frame: 0
  };
  /* where you wake when you are broken */
  sim.ship = { x: sim.player.x, z: sim.player.z };
  sim.lastReckoning = null;

  /* ============================================================
     M12 — THREE HUNTERS. `sim.hunters[0]` IS `sim.player` (same object, so
     every single-hunter code path and all prior tests keep meaning what
     they meant). Seats 1–2 are the partners: three scent volumes, three
     noise radii, three chances someone breaks cover (§11).
     `mods` per seat is exchanged at the MP handshake and static in-session —
     each client's kit/injury economy stays its own; only what the WORLD can
     sense (position, noise, cloak, bleed) lives here.
     ============================================================ */
  sim.player.seat = 0;
  sim.player.mods = null;              // null = seat 0 uses the live hunterMods
  sim.player.cmd = null;
  sim.hunters = [sim.player];
  sim.mp = false;                      // true = lockstep: commands move seats

  sim.setHunterCount = function(n){
    n = Math.max(1, Math.min(3, n|0));   // three, not four — canon (§11)
    while(sim.hunters.length > n) sim.hunters.pop();
    while(sim.hunters.length < n){
      const i = sim.hunters.length;
      sim.hunters.push({
        seat:i, x:sim.ship.x + i*2.5, z:sim.ship.z + i*1.5, yaw:0,
        moving:false, crouch:false, slow:false, noise:0, scentStrength:1.0,
        cloaked:false, spears:3, bleed:0,
        mods:{ speed:1, noise:0 },     // handshake values; static in-session
        cmd:null
      });
    }
    return sim.hunters.length;
  };

  /* one seat's input for the CURRENT tick. In MP this is the only way a
     hunter moves; every client applies the identical command set. */
  sim.hunterCmd = function(seat, cmd){
    const h = sim.hunters[seat]; if(!h) return;
    h.cmd = cmd;
  };

  sim.moveHunter = function(h, dt){
    const c = h.cmd; if(!c) { h.moving=false; return; }
    h.yaw = c.yaw ?? h.yaw;
    h.crouch = !!c.crouch; h.slow = !!c.slow;
    if(c.cloak !== undefined) h.cloaked = !!c.cloak;
    /* a thrown spear / a swing / a call is LOUD — the spike rides the
       move command so every client hears the same hunter */
    if(c.n) h.noise = Math.max(h.noise, c.n);
    let fx = c.fx||0, fz = c.fz||0;
    h.moving = !!(fx||fz);
    if(h.moving){
      const l=Math.hypot(fx,fz); fx/=l; fz/=l;
      const m = (h.seat===0 && !sim.mp) ? sim.hunterMods()
              : (h.mods || {speed:1, noise:0});
      let sp=(h.crouch?1.6:h.slow?2.1:5.0)*(m.speed||1);
      if(h.bleed>0) sp*=BLEED_SPEED;
      /* the camera basis from the M1 fix — same math the view used */
      const cs=Math.cos(h.yaw), sn=Math.sin(h.yaw);
      const nx=h.x+(fx*cs+fz*sn)*sp*dt, nz=h.z+(-fx*sn+fz*cs)*sp*dt;
      if(Math.abs(nx)<WORLD_SIZE*0.47 && Math.abs(nz)<WORLD_SIZE*0.47 &&
         world.heightAt(nx,nz)>WATER_Y-0.3){ h.x=nx; h.z=nz; }
    }
  };
  /* THIS WORLD's law, biome and biology (M4) */
  sim.groundKey = groundKey;
  sim.wgen = wgen;
  sim.species = speciesTable;
  sim.law = LAWS[wgen.law];
  sim.biome = BIOMES[wgen.biome];

  /* ---------- time ---------- */
  sim.todHours = () => (sim.simSec/DAY_SEC)*24 % 24;
  sim.phaseName = () => {
    const h=sim.todHours();
    for(const [n,a,b] of PHASES) if(h>=a&&h<b) return n;
    return 'NIGHT';
  };
  /* 0 = pitch dark, 1 = full light. Drives how well SIGHT works. */
  sim.lightLevel = () => {
    const h=sim.todHours();
    return Math.max(0.06, Math.sin((h-6)/24*Math.PI*2)*0.5+0.5);
  };

  sim.windVec = () => ({x:Math.sin(sim.wind.dir), z:Math.cos(sim.wind.dir)});

  /* ---------- the ONE way time moves ----------
     step, rest-skip and a blackout all funnel through here, so nothing that
     ages with the clock can be forgotten at one of the three call sites. */
  sim.advanceTime = function(sec){
    sim.simSec += sec;
    for(const t of sim.tracks) t.age += sec;
    if(sim.hunter.bleed>0) sim.hunter.bleed = Math.max(0, sim.hunter.bleed-sec);
    const inj = sim.hunter.injuries;
    for(const k of Object.keys(inj)){
      inj[k].left -= sec;
      if(inj[k].left <= 0){
        if(inj[k].sev > 1){ inj[k].sev--; inj[k].left = INJURIES[k].days*DAY_SEC; }
        else delete inj[k];                       // healed
      }
    }
  };

  /* ---------- what the injuries actually DO ----------
     No debuff icons. Every field here is read by real code. */
  sim.hunterMods = function(){
    const m = {noise:0, speed:1, con:1, throwErr:0, optic:0, count:0,
               bleeding:sim.hunter.bleed>0};
    if(m.bleeding){ m.noise += BLEED_NOISE; m.speed *= BLEED_SPEED; m.con *= 0.8; }
    for(const k of Object.keys(sim.hunter.injuries)){
      const I = INJURIES[k], s = sim.hunter.injuries[k].sev;
      m.count += s;
      m.noise    += (I.noise||0)*s;
      m.speed    *= Math.pow(1+(I.speed||0), s);
      m.con      *= Math.pow(1+(I.con||0), s);
      m.throwErr += (I.throwErr||0)*s;
      if(I.optic) m.optic = Math.max(m.optic, s);
    }
    return m;
  };
  sim.hasKit = k => !!sim.hunter.kit[k];

  /* ---------- player signature on each channel ---------- */
  /* per-seat noise: seat 0 reads the live injury mods; partners carry the
     static mods from the MP handshake, plus any in-session bleed */
  sim.hunterNoise = function(h, dt){
    /* ⚠️ MP: EVERY seat uses its static handshake mods — sim.hunterMods()
       reads the LOCAL client's kit, which differs per client and would
       desync the noise the whole world hears */
    const mod = (h.seat===0 && !sim.mp) ? sim.hunterMods()
              : { noise:((h.mods&&h.mods.noise)||0)+(h.bleed>0?BLEED_NOISE:0) };
    let n;
    if(h.moving){
      n = h.crouch?0.16 : h.slow?0.30 : 0.78;
      n *= 0.55 + world.substrateAt(h.x,h.z)*0.9;
      n *= 1 + world.coverAt(h.x,h.z)*0.35;
      n *= 1 + mod.noise;                 // a limp, cracked ribs: stillness costs
    } else n = 0.02 + mod.noise*0.06;     // broken ribs are audible standing still
    h.noise += (n-h.noise)*Math.min(1,dt*6);
    return h.noise;
  };
  sim.playerNoise = function(dt){ return sim.hunterNoise(sim.player, dt); };

  /* SCENT: how much of ONE hunter reaches a point. Upwind = zero, always. */
  sim.scentFrom = function(h, tx, tz){
    const w=sim.windVec();
    const dx=tx-h.x, dz=tz-h.z, dist=Math.hypot(dx,dz);
    if(dist<0.001) return 1;
    const along = (dx/dist)*w.x + (dz/dist)*w.z;
    if(along<=0.02) return 0;
    const cone = Math.pow(Math.max(0,along), 3.0);
    const carry = 30 + sim.wind.strength*46;
    const fall = Math.max(0, 1-dist/carry);
    return cone*fall*fall*h.scentStrength*(0.45+sim.wind.strength*0.75);
  };
  /* ⚠️ THREE SCENT VOLUMES (§11): what a nose smells is the STRONGEST of the
     party — one partner standing upwind ruins everyone's stalk, and that is
     the whole content of co-op. Single-hunter results are byte-identical. */
  sim.scentAt = function(tx,tz){
    let s=0;
    for(const h of sim.hunters) s=Math.max(s, sim.scentFrom(h,tx,tz));
    return s;
  };

  /* SIGHT: ordered cones (Thief), gated by cover, light, motion, LOS, cloak. */
  sim.sightFrom = function(h, ox, oz, facing){
    if(prof.sight<=0 || h.cloaked) return 0;
    const dx=h.x-ox, dz=h.z-oz, dist=Math.hypot(dx,dz);
    if(dist>prof.sightRange) return 0;
    let ang = Math.atan2(dx,dz) - facing;
    while(ang>Math.PI) ang-=Math.PI*2; while(ang<-Math.PI) ang+=Math.PI*2;
    const a=Math.abs(ang);
    let coneMul;
    if(a < prof.fov*0.5)            coneMul = 1.0;      // direct
    else if(a < prof.peripheral*0.5) coneMul = 0.45;    // peripheral
    else                             coneMul = 0.06;    // rear "spidey-sense"
    const py = world.heightAt(h.x,h.z) + (h.crouch?1.05:1.7);
    if(!world.hasLOS(ox, world.heightAt(ox,oz)+2.6, oz, h.x, py, h.z)) return 0;
    const distF = Math.max(0, 1 - dist/prof.sightRange);
    const conceal = world.coverAt(h.x,h.z) * (h.crouch?0.92:0.45);
    const motion  = h.moving ? (h.crouch?0.55:h.slow?0.75:1.0) : 0.30;
    return coneMul * distF*distF * (1-conceal) * motion * sim.lightLevel();
  };
  /* three chances someone breaks cover (§11) — the eye catches the WORST of you */
  sim.sightAt = function(ox,oz,facing){
    let s=0;
    for(const h of sim.hunters) s=Math.max(s, sim.sightFrom(h,ox,oz,facing));
    return s;
  };

  /* ---------- schedule ---------- */
  sim.zoneForTime = function(){
    const h=sim.todHours(), Z=world.zones;
    if(h>=4  && h<9 ) return {z:Z.feed, s:'GRAZE'};
    if(h>=9  && h<12) return {z:Z.water,s:'DRINK'};
    if(h>=12 && h<17) return {z:Z.feed, s:'GRAZE'};
    if(h>=17 && h<20) return {z:Z.water,s:'DRINK'};
    return {z:Z.bed, s:'BED'};
  };

  /* ---------- wind ---------- */
  sim.updateWind = function(dt){
    const w=sim.wind;
    w.t+=dt;
    if(w.t>16){ w.t=0; w.targetDir = w.dir + (world.rng()-0.5)*1.5; }
    let d=w.targetDir-w.dir;
    while(d>Math.PI) d-=Math.PI*2; while(d<-Math.PI) d+=Math.PI*2;
    w.dir += d*dt*0.09;
    const gust = world.fbm(w.dir*3+sim.simSec*0.004, 12.7, 2)*0.5+0.5;
    w.strength += (0.18+gust*0.85 - w.strength)*dt*0.35;
  };

  /* ---------- the quarry ---------- */
  sim.updateQuarry = function(dt){
    const Q=sim.Q; let p=sim.player;
    /* ⚠️ the world bound is UNCONDITIONAL. It used to live inside the movement
       branch, so anything that placed the quarry while it was gone/dead (an
       early return) was never clamped back and it could sit outside the world. */
    const lim0=WORLD_SIZE*0.47;
    Q.x=Math.max(-lim0,Math.min(lim0,Q.x));
    Q.z=Math.max(-lim0,Math.min(lim0,Q.z));
    /* a CHARGING quarry keeps updating even though it has already decided to
       leave - it is leaving through you */
    /* the wound clock runs even on a beast that has "left" — it cannot
       outrun its own blood, and the trail leads to wherever it fell */
    sim.tickWound(Q, dt);
    if(!Q.alive || (Q.gone && !Q.charging)) return;
    if(Q.state==='BEDDED'){ Q.speed=0; return; }
    Q.stateT+=dt;

    /* ⚠️ THE FOCUS SEAT (M12). Every hunter's noise ticks every frame; the
       beast reacts to the LOUDEST/CLEAREST of the party, flees from and
       charges THAT one. With one hunter this reduces byte-identically to
       the old code — `p` below is the focus, and the focus of a party of
       one is the player. */
    let focus=p, hearing=0, smell=0, seeing=0;
    for(const h of sim.hunters){
      const hn = sim.hunterNoise(h, dt);
      const hd = Math.hypot(Q.x-h.x, Q.z-h.z);
      const hHear = Math.max(0, 1 - hd/(9 + hn*prof.hearRange)) * hn * prof.sound;
      const hSmell= sim.scentFrom(h, Q.x, Q.z) * prof.scent;
      const hSee  = sim.sightFrom(h, Q.x, Q.z, Q.facing) * prof.sight;
      if(Math.max(hHear,hSmell,hSee) >= Math.max(hearing,smell,seeing)){
        focus=h; hearing=hHear; smell=hSmell; seeing=hSee;
      }
    }
    p = focus;
    const noise = p.noise;
    const d = Math.hypot(Q.x-p.x, Q.z-p.z);

    /* strongest channel wins (Thief) - and we remember WHICH, so the
       player can be told what betrayed them */
    let stim=hearing, ch='SOUND';
    if(smell>stim){ stim=smell; ch='SCENT'; }
    if(seeing>stim){ stim=seeing; ch='SIGHT'; }
    /* a beast that has broken you once KNOWS you. It is not stronger, it is
       harder to get near - which is exactly what a nemesis should be. */
    if(Q.wary) stim *= 1 + Q.wary*0.22;
    if(stim>0.02) Q.lastChannel=ch;

    /* AWARENESS: an INTEGRATOR, not a follower.
       ⚠️ It used to be `awareness += (stim-awareness)*k`, which converges TO the
       current stimulus and stalls there - a quarry pinned beside a loud player
       froze at 0.277 forever and could never spook. Sustained exposure has to
       ACCUMULATE or stalking means nothing. Caught by the headless battery. */
    if(stim > STIM_FLOOR){
      Q.riseFilter += dt;                       // reaction delay (Thief)
      if(Q.riseFilter > 0.28) Q.awareness += stim * RISE_RATE * dt;
    } else {
      Q.riseFilter = 0;
      Q.awareness -= DECAY_RATE * dt;           // capacitor drain
    }
    Q.awareness = Math.max(0,Math.min(1,Q.awareness));

    const prev=Q.alertState;
    Q.alertState = Q.awareness>=SPOOK_AT ? 'SPOOKED' : Q.awareness>=ALERT_AT ? 'ALERT' : 'CALM';
    /* THE RECKONING's record. Butchery is "it never knew you were there" —
       that is this flag, and nothing else. */
    if(Q.alertState!=='CALM') Q.everAware=true;
    /* OSSUN: a full feeding cycle, OBSERVED. Being on the same world is not
       observing — you have to be close enough to see it and have line of sight. */
    if(d<OBSERVE_RANGE && (Q.state==='GRAZE'||Q.state==='DRINK'||Q.state==='BED')){
      const py=world.heightAt(p.x,p.z)+(p.crouch?1.05:1.7);
      if(world.hasLOS(p.x,py,p.z,Q.x,world.heightAt(Q.x,Q.z)+2.6,Q.z))
        Q.cycleSeen[Q.state]=true;
    }
    let justSpooked=false, broke=null;
    if(prev!=='SPOOKED' && Q.alertState==='SPOOKED'){
      Q.spooks++; Q.state='FLEE'; Q.stateT=0; justSpooked=true;
      if(Q.spooks>=3){
        /* Three spooks and it leaves - that rule is unchanged. But if you
           pressed it from inside CHARGE_RANGE it goes through you on the
           way out, and how much fight it has is prof.threat. */
        Q.gone=true;
        if(d<=CHARGE_RANGE && prof.threat>0.2){
          Q.charging=true; Q.state='CHARGE'; Q.chargeAim=Math.atan2(p.x-Q.x,p.z-Q.z);
          /* KRAHN's rite: the quarry initiated. Only true if you had not
             already put a spear in it. */
          if(Q.strikes===0) Q.quarryInitiated=true;
          sim.hunter.gaveGround=false; sim._ground=0;  // hold, and it counts
        }
      }
    }

    /* behaviour */
    let tx,tz,spd;
    if(Q.state==='CHARGE'){
      /* Committed heading, slow correction — break laterally and it misses.
         The correction FADES as it closes: nothing at a dead run pivots in
         the last few metres. That is what makes a late break a real skill
         check instead of a coin flip, and it is why a charge launched from
         4m is simply not dodgeable. */
      let da=Math.atan2(p.x-Q.x,p.z-Q.z)-Q.chargeAim;
      while(da>Math.PI) da-=Math.PI*2; while(da<-Math.PI) da+=Math.PI*2;
      const turn=CHARGE_TURN*Math.min(1,d/CHARGE_COMMIT)*dt;
      Q.chargeAim += Math.max(-turn, Math.min(turn, da));
      tx=Q.x+Math.sin(Q.chargeAim)*40; tz=Q.z+Math.cos(Q.chargeAim)*40;
      spd=CHARGE_SPEED;
      /* first strike opens you up; a strike while already bleeding breaks you */
      if(d<=CONTACT_R){
        broke = sim.strikeSeat(p, 'charge', Q);
      }
      else if(Q.stateT>CHARGE_MAX){ Q.charging=false; Q.state='FLEE'; Q.stateT=0;
        if(Q.quarryInitiated) Q.quarryDisengaged=true; }
      /* VOKAAR's rite: you met it WITHOUT GIVING GROUND. Backing away from a
         thing that is coming at you is the most natural act there is, which
         is exactly why not doing it is worth x5.
         ⚠️ This CANNOT be measured from distance — the quarry is closing, so
         d shrinks whether you hold or run. It has to be YOUR movement,
         projected onto the away-from-it axis. */
      if(sim._pPrev){
        const mx=p.x-sim._pPrev.x, mz=p.z-sim._pPrev.z;
        const ax=p.x-Q.x, az=p.z-Q.z, al=Math.hypot(ax,az)||1;
        const away=(mx*ax + mz*az)/al;
        if(away>0) sim._ground=(sim._ground||0)+away;
        if(sim._ground>GROUND_GIVEN) sim.hunter.gaveGround=true;
      }
    } else if(Q.state==='FLEE'){
      const ax=Q.x-p.x, az=Q.z-p.z, l=Math.hypot(ax,az)||1;
      tx=Q.x+ax/l*30; tz=Q.z+az/l*30; spd=7.5;
      if(Q.stateT>4.5){ Q.state='TRAVEL'; Q.stateT=0; }
    } else if(Q.curious && Q.alertState==='CALM'){
      /* investigating your call — every sense still live the whole way in */
      Q.curious.t-=dt;
      tx=Q.curious.x; tz=Q.curious.z; spd=1.6; Q.state='TRAVEL';
      if(Q.curious.t<=0 || Math.hypot(Q.x-tx,Q.z-tz)<6) Q.curious=null;
    } else {
      if(Q.alertState!=='CALM') Q.curious=null;   // spooked mid-approach
      const want=sim.zoneForTime();
      tx=want.z.x; tz=want.z.z;
      const dz=Math.hypot(Q.x-tx,Q.z-tz);
      if(dz<7){ Q.state=want.s; spd = Q.alertState==='ALERT'?0.35:0.55; }
      else { Q.state='TRAVEL'; spd = Q.alertState==='ALERT'?1.5:2.1; }
      if(Q.state==='BED') spd=0.06;
      if(Q.state==='GRAZE'||Q.state==='DRINK'){
        tx += Math.sin(sim.simSec*0.05+Q.x)*5;
        tz += Math.cos(sim.simSec*0.043+Q.z)*5;
      }
    }
    /* ⚠️ THE WOUND IS IN THE MOVEMENT EQUATION, not an icon. A crippled leg
       is a hard cap; blood loss drains the rest. "A leg changes gait and
       shortens flight" — you can literally watch it slow down. */
    if(Q.wound){
      if(Q.wound.part==='leg') spd *= WOUNDS.leg.cripple;
      spd *= 0.45 + 0.55*Q.blood;
    }
    const dx=tx-Q.x, dz2=tz-Q.z, L=Math.hypot(dx,dz2);
    if(L>0.4){
      const nx=dx/L, nz=dz2/L;
      Q.x+=nx*spd*dt; Q.z+=nz*spd*dt;
      let da = Math.atan2(nx,nz)-Q.facing;
      while(da>Math.PI) da-=Math.PI*2; while(da<-Math.PI) da+=Math.PI*2;
      Q.facing += da*Math.min(1,dt*3);
      Q.speed=spd;
      const lim=WORLD_SIZE*0.47;
      Q.x=Math.max(-lim,Math.min(lim,Q.x));
      Q.z=Math.max(-lim,Math.min(lim,Q.z));
      if(sim.simSec-Q.lastPrint > (spd>4?0.5:2.2)){
        Q.lastPrint=sim.simSec;
        sim.tracks.push({x:Q.x,z:Q.z,age:0});
        if(sim.tracks.length>200) sim.tracks.shift();
      }
    } else Q.speed=0;

    sim._pPrev = {x:p.x, z:p.z};
    return {hearing, smell, seeing, stim, channel:ch, justSpooked, broke};
  };

  sim.step = function(dt){
    /* ⚠️ simSec is REAL SECONDS ELAPSED, and todHours/restSkip/PHASES/the
       initial simSec are all written in those units. This used to multiply by
       86400/DAY_SEC, which ran the world 16x fast: a "90 minute day" (the
       locked decision in S4, and the whole reason the schedule is plannable)
       completed in 5.6 real minutes. */
    sim.advanceTime(dt);
    sim.updateWind(dt);
    const per = sim.updateQuarry(dt);
    sim.updateFauna(dt);          // the rest of the web, watched or not
    sim.updateClaims();
    for(const b of sim.blood) b.age += dt;
    const clanBroke = sim.updateClan(dt);
    const colBroke  = sim.updateColony(dt);
    if(per) per.broke = per.broke || clanBroke || colBroke;
    sim.frame++;
    return per;
  };

  /* ============================================================
     THE WOUND. Nothing rewinds. You wake on the ship, injured, and the
     beast is still down there wearing a piece of your kit.
     ============================================================ */
  /* ============================================================
     THE STRIKE and THE RECKONING (M2)
     ============================================================ */

  /* Roll this world's specimen once, at setup. It is READABLE through the
     optics before you commit (§3) — otherwise players kill everything and
     check afterward, which is the slot-machine behaviour this must not have. */
  sim.rollQuarry = function(){
    const sp=sim.species[sim.Q.species];
    sim.Q.tier = sp.tier;
    sim.Q.specimenPct = rollSpecimen(world.rng, sp.namedChance);
    sim.Q.gravid = world.rng() < sp.gravidChance;
    /* §8: THE NAMED are procedurally named AND HISTORIED. A Named beast the
       game cannot describe is just a bigger health bar. */
    sim.Q.named = sim.Q.specimenPct >= NAMED_PCT
      ? nameTheNamed(world.rng, wgen.biome) : null;
  };

  /* What you can READ, given where you are and what optic you are using.
     Distance gates it; the pheromone optic is the ONLY way to see gravid —
     that is the whole reason the prohibition is fair. */
  sim.assess = function(optic){
    const Q=sim.Q, p=sim.player;
    const d=Math.hypot(Q.x-p.x, Q.z-p.z);
    const mod=sim.hunterMods();
    const range = (optic===0?70:200) * (mod.optic?0.5:1);
    if(d>range) return {inRange:false, dist:d};
    Q.assessed=true;
    return {
      inRange:true, dist:d,
      tier:Q.tier, specimenPct:Q.specimenPct,
      /* ⚠️ gravid is ONLY visible through the pheromone optic (optic 2). The
         Void punishes killing her; this is how you were told. */
      gravid: optic===2 ? Q.gravid : null,
      species:sim.species[Q.species].label
    };
  };

  /* A strike lands. `part` is where it hit — a skull shot ruins the trophy.
     Returns the Reckoning if this killed it, else the wound record. */
  /* ⚠️ `target` defaults to the player's quarry but ANY creature can be
     struck. The first version hardcoded sim.Q, so fourteen of the fifteen
     animals on screen were invulnerable scenery — you could put a spear
     straight through one and nothing happened. (Kyle found this by playing;
     no test caught it because every test struck the quarry.) */
  sim.strike = function({dist, part='body', thrown=true, lethal=true, target=null,
                         weapon=null, by=null}){
    const Q=target||sim.Q, H=sim.hunter, sp=sim.species[Q.species];
    /* M12: `by` = which SEAT threw. Defaults to seat 0; a partner's strike
       grades on the partner's cloak, and the party splits the condition. */
    const striker = by || sim.player;
    if(!Q.alive){
      /* OVERKILL — going on striking a dead thing. Recorded, and it voids. */
      Q.strikes++;
      if(H.trophies.length){
        const last=H.trophies[H.trophies.length-1];
        if(!last.voided){ H.honor-=last.score; last.voided='overkill';
          last.voidReason='You went on striking a dead thing.';
          last.score=0; H.voids++; }
      }
      return {overkill:true};
    }
    Q.strikes++;
    /* legacy alias: 'body' always meant a placed chest hit */
    if(part==='body') part='vitals';
    if(!lethal) return {wounded:true, strikes:Q.strikes};

    /* ⚠️ capture what was TRUE at the moment of the strike before anything
       changes — VOKAAR's rite is "it was coming at you", and clearing the
       flag first would silently make the highest grade unreachable. */
    const wasCharging = Q.charging || Q.state==='CHARGE';

    const approach = gradeApproach(dist, striker.cloaked, Q);
    const run = (H.lastApproach[Q.species]===approach) ? (H.approachRun[Q.species]||0) : 0;

    const ctx = {
      tier:Q.tier, specimenPct:Q.specimenPct,
      cloaked:striker.cloaked, everAware:Q.everAware,
      dist, reach:sp.reach, engageRange:CHARGE_RANGE, thrown,
      drewBlood:Q.drewBlood, wasCharging,
      gaveGround:H.gaveGround, strikes:Q.strikes,
      quarryInitiated:Q.quarryInitiated, quarryDisengaged:Q.quarryDisengaged,
      cycleObserved: !!(Q.cycleSeen.GRAZE && Q.cycleSeen.DRINK && Q.cycleSeen.BED),
      inBeddingGround: Math.hypot(Q.x-world.zones.bed.x, Q.z-world.zones.bed.z) < 14,
      doctrine:H.doctrine, species:Q.species,
      /* VOKAAR caps a fleeing kill at Clean; KRAHN voids it outright.
         ⚠️ a BEDDED beast is not fleeing — it is dying, and finishing it
         there is the merciful end KRAHN's code allows */
      fleeing: (Q.state==='FLEE' || Q.alertState==='SPOOKED') && Q.state!=='BEDDED',
      /* M8: the weapon in your hand sets the ceiling. The blade never caps. */
      weaponCap: weaponCap(H, weapon || (thrown ? (H.primary||'spears') : 'blade')),
      /* M11/§5: witnessed by the unworthy, and you did not break contact */
      witnessed: H.witnessed,
      integrity: part==='skull' ? INTEGRITY.skull
               : part==='vitals' ? INTEGRITY.clean : INTEGRITY.bodyDamage,
      party:sim.hunters.length, consecutive:run,
      gravid:Q.gravid, noThreat: sp.threat<=0
    };

    /* repetition is committed at the STRIKE, kill or wound — you took the
       approach either way, and a reload must not launder it */
    H.lastApproach[Q.species]=approach;
    H.approachRun[Q.species]=run+1;

    /* ============================================================
       ⚠️ NOT EVERY HIT KILLS (§3). Gut and leg are WOUNDS: the beast runs,
       bleeding, and the tracking game begins. The trophy is graded NOW —
       at the moment of the hit — but banked only when you find the body.
       ============================================================ */
    if(part==='gut' || part==='leg'){
      const W_=WOUNDS[part];
      Q.wound = Q.wound || { part, at:sim.simSec, ctx:null, approach };
      Q.wound.part = part;
      Q.bleedRate = (Q.bleedRate||0) + W_.bleed;
      /* only a wound that can kill carries a pending reckoning */
      if(part==='gut') Q.wound.ctx = {...ctx};
      /* it runs, and it knows exactly what did this to it */
      Q.everAware=true; Q.awareness=1; Q.alertState='SPOOKED';
      Q.state='FLEE'; Q.stateT=0; Q.charging=false;
      if(Q===sim.Q) Q.spooks=Math.max(Q.spooks,1);
      return { wounded:true, part, strikes:Q.strikes, tell:W_.tell };
    }

    /* skull / vitals: it drops where it stands */
    Q.alive=false; Q.charging=false;

    const rec = trophyScore(ctx);
    /* ⚠️ Bounty is NOT zeroed by the Void. A butcher still gets paid — that
       asymmetry is the point of two currencies (§6). */
    rec.bounty = bountyValue({...ctx, method:rec.method});
    rec.species = sp.label; rec.approach = approach;
    rec.at = sim.simSec; rec.dist = dist; rec.part = part;
    /* a NAMED falls with its name — the wall should read like a chronicle */
    if(Q.named){ rec.named = {...Q.named};
      rec.species = sp.label+' — '+Q.named.name+' '+Q.named.epithet; }

    sim.bankTrophy(rec);
    return rec;
  };

  /* ============================================================
     ⚠️ ONE FUNNEL FOR EVERY TROPHY — a kill in the open and a carcass
     claimed at the end of a blood trail must move standing, disgrace and
     the cloak grant IDENTICALLY, or the two paths drift apart.
     ============================================================ */
  sim.bankTrophy = function(rec){
    const H=sim.hunter;
    H.honor += rec.score;
    H.bounty += rec.bounty||0;
    if(rec.voided) H.voids++;
    H.trophies.push(rec);
    sim.lastReckoning = rec;
    /* M9: standing is a ROLLING AVERAGE, so it moves both ways every time */
    rec.standingBefore = H.standing || 0;
    H.standing = standing(H.trophies);
    rec.standingAfter = H.standing;
    rec.rank = rankOf(H.standing);
    /* M10: the fall, or the climb back out of it */
    const fellBefore = H.fall;
    H.disgrace = disgrace(H.trophies);
    const f = fallOf(H.disgrace);
    H.fall = f.key; H.badBlood = !!f.hunted;
    rec.disgrace = H.disgrace; rec.fall = f;
    if(f.key !== fellBefore) rec.fellTo = f;
    /* THE CLOAK IS EARNED (§10) — threshold, not rank (see M9 notes) */
    const d = DOCTRINES[H.doctrine];
    const elder = RANKS.find(r=>r.grants==='cloak');
    if(elder && H.standing >= elder.at && !H.kit.cloak && !H.everHadCloak
       && !(d&&d.noCloak)){
      H.kit.cloak = true; H.everHadCloak = true; rec.granted = 'cloak';
    }
    return rec;
  };

  /* ============================================================
     THE CLAIM. A beast that died of your wound is only a trophy once you
     STAND OVER IT — and §5's void is live the whole walk: "letting something
     else finish your quarry" scores zero.
     ============================================================ */
  sim.updateClaims = function(){
    /* M12: ANY hunter of the party standing over it claims for the party */
    for(const k of sim.carrion){
      if(!k.claim) continue;
      const sp=sim.species[k.species];
      if((k.eaten||0) > SCAVENGE_LOSS){
        /* something else got there first */
        const rec=trophyScore({...k.claim.ctx, scavenged:true});
        rec.bounty=0; rec.species=sp?sp.label:'—';
        rec.at=sim.simSec; rec.trailed=true;
        sim.bankTrophy(rec); sim.claimed=rec; k.claim=null;
      } else if(sim.hunters.some(h=>Math.hypot(k.x-h.x, k.z-h.z) < CLAIM_R)){
        const rec=trophyScore(k.claim.ctx);
        rec.bounty=bountyValue({...k.claim.ctx, method:rec.method});
        rec.species=sp?sp.label:'—';
        rec.at=sim.simSec; rec.trailed=true;
        sim.bankTrophy(rec); sim.claimed=rec; k.claim=null; k.claimed=true;
      }
    }
  };

  /* Which of the five approaches (§5) did you actually take? Read, not chosen. */
  /* reach is the TARGET's, not the quarry's — a blade inside a skimmer's
     reach is close work even when you came here for something else */
  function gradeApproach(dist, cloaked, target){
    const t = target || sim.Q;
    if(cloaked) return 'cloaked';
    if(dist > CHARGE_RANGE*2) return 'standoff';
    if(dist > sim.species[t.species].reach) return 'open';
    return t.drewBlood ? 'offered' : 'blades';
  }
  sim.gradeApproach = gradeApproach;

  /* TIER 1 — IT OPENS YOU UP. The hunt does NOT end.
     It hit you, it broke off, and it is still here and now genuinely in a
     fight with you. Its spook count is set to 2, so one more press brings it
     back through you — and this time you are bleeding, which is the second
     strike. That escalation IS the Contest. */
  /* ============================================================
     M12 — a strike lands on a SEAT. Seat 0 in single-player takes the full
     personal path (kit, injuries, blackout — exactly as before). Any seat
     in lockstep takes the SLIM path: every client consumes the SAME rng
     draws and mutates the SAME world state; only the victim's client applies
     the personal consequences from the returned event.
     ⚠️ In MP there is NO blackout — a break cannot yank three hunters'
     shared clock (the bible's co-op day question, answered: the day is
     shared and nobody's failure spends it).
     ============================================================ */
  sim.pendingLossSeat = null;
  /* the world's actors take the NEAREST of the party — deterministic on
     every client, and the person who wandered closest pays for it */
  sim.nearestHunter = function(x,z){
    let best=sim.hunters[0], bd=1e18;
    for(const h of sim.hunters){
      const d=(h.x-x)*(h.x-x)+(h.z-z)*(h.z-z);
      if(d<bd){ bd=d; best=h; }
    }
    return best;
  };
  sim.strikeSeat = function(h, cause, by){
    if(h.seat===0 && !sim.mp){
      return sim.hunter.bleed>0 ? sim.breakHunter(cause) : sim.woundHunter(cause, by);
    }
    const Q = by || sim.Q, rng = world.rng;
    if(h.bleed>0){
      /* BROKEN. Identical rng draws on every client; personal application
         is the victim's business. */
      const key = INJURY_KEYS[Math.floor(rng()*INJURY_KEYS.length)];
      h.bleed = 0;
      h.x = sim.ship.x + h.seat*2.5; h.z = sim.ship.z + h.seat*1.5;
      h.moving=false; h.cloaked=false; h.noise=0; h.spears=3;
      /* the beast keeps a piece — WHICH piece arrives later as a command */
      sim.pendingLossSeat = h.seat;
      Q.gone=false; Q.charging=false; Q.spooks=0; Q.awareness=0;
      Q.alertState='CALM'; Q.state='TRAVEL'; Q.stateT=0;
      Q.wary=Math.min(3,(Q.wary||0)+1);
      const want=sim.zoneForTime(), lim=WORLD_SIZE*0.47;
      Q.x=Math.max(-lim,Math.min(lim, want.z.x+(rng()-0.5)*46));
      Q.z=Math.max(-lim,Math.min(lim, want.z.z+(rng()-0.5)*46));
      return {tier:'broken', seat:h.seat, cause, injury:key, mp:true,
              options:KIT_TAKEABLE.slice()};
    }
    h.bleed = BLEED_HOURS/24*DAY_SEC;
    Q.drewBlood = true;
    Q.charging=false; Q.gone=false; Q.state='FLEE'; Q.stateT=0;
    Q.awareness = Math.min(Q.awareness, SPOOK_AT-0.03);
    Q.alertState='ALERT';
    if(Q===sim.Q) Q.spooks = 2;
    Q.wary = Math.min(3,(Q.wary||0)+1);
    return {tier:'bleeding', seat:h.seat, cause};
  };
  /* ⚠️ THE SLIM BREAK'S PERSONAL HALF. strikeSeat moves the SEAT (shared,
     lockstep); this applies the same break to the LOCAL ledger — and it lives
     here, next to breakHunter, because the injury record has a SHAPE
     ({sev,left}) that hunterMods() destructures. A view-side hand-rolled
     `injuries[k] = n` poisons every mod with NaN: throwErr NaN sends spears
     to nowhere, and it survives for the rest of the session. */
  sim.applyLocalBreak = function(ev){
    const H=sim.hunter;
    if(!ev || ev.tier!=='broken' || !INJURIES[ev.injury]) return null;
    const mod=sim.hunterMods();                 // read BEFORE we add the injury
    const cur=H.injuries[ev.injury];
    const sev=Math.min(3,(cur?cur.sev:0)+1);
    H.injuries[ev.injury]={ sev,
      left: INJURIES[ev.injury].days*DAY_SEC*(0.7+sev*0.3)/mod.con };
    H.breaks++; H.bleed=0;
    const pool=KIT_TAKEABLE.filter(k=>H.kit[k]);
    H.pendingLoss = pool.length ? {options:pool} : null;
    return {injury:ev.injury, sev, options:pool};
  };

  /* the broken player chose what the beast keeps — arrives as a lockstep
     command so every client's Q.carrying agrees */
  sim.applyLossCmd = function(seat, key){
    if(sim.pendingLossSeat!==seat) return false;
    sim.pendingLossSeat = null;
    sim.Q.carrying = key;
    return true;
  };

  /* ============================================================
     M12 — THE LOCKSTEP TICK. AoT's pattern: commands are SEMANTIC (the
     local client resolves its own aim; the command carries the result),
     every client applies the identical command set in the identical order,
     then steps the identical fixed dt. Nothing else moves a seat in MP.
     ============================================================ */
  sim.MP_TICK = 0.05;                        // 20Hz, same as Age of Toys
  sim.applyCmd = function(seat, c){
    const h = sim.hunters[seat]; if(!h || !c) return null;
    switch(c.t){
      case 'move':  sim.hunterCmd(seat, c); return null;
      case 'loss':  sim.applyLossCmd(seat, c.key); return null;
      case 'reed':  sim.callQuarry(h); return null;
      case 'strike': {
        if(c.target==='clan')
          return sim.strikeClan({dist:c.dist, part:c.part||'body'});
        /* fauna index is deterministic — the array is seeded worldgen,
           mutated identically on every client */
        const target = (c.target==null || c.target==='Q') ? null
                     : (sim.fauna[c.target] || null);
        if(target===null && c.target!=null && c.target!=='Q') return null;
        const rec = sim.strike({dist:c.dist, part:c.part||'body',
                                thrown:c.thrown!==false, target,
                                weapon:c.weapon||null, by:h});
        /* the nemesis take-back, sim-side: the kill clears what it carried
           on EVERY client; the striking client grants itself the kit when
           it sees `took` on the echo */
        const T = target || sim.Q;
        if(rec && !rec.wounded && !rec.overkill && T.carrying){
          rec.took=T.carrying; T.carrying=null; }
        return rec;
      }
      case 'miss': {
        /* a spear in the dirt spooks whatever is near it */
        const Q=sim.Q;
        if(Q.alive && !Q.gone && Math.hypot(c.x-Q.x, c.z-Q.z)<28)
          Q.awareness=Math.min(1, Q.awareness+0.5);
        return null;
      }
      case 'charge': {
        /* stand into a charge with the blade — the offered-fight path */
        return sim.applyCmd(seat, {...c, t:'strike', thrown:false});
      }
      case 'strikeCol': {
        const q = sim.colony && sim.colony.people[c.idx];
        if(!q) return null;
        return sim.strikeColonist({target:q, dist:c.dist, part:c.part||'body', by:h});
      }
    }
    return null;
  };
  /* one lockstep frame: the merged command list for this tick, in seat-then-
     arrival order (host-canonical), then movement, then the world. */
  sim.mpTick = function(cmds){
    const res = [];
    for(const [seat, c] of (cmds||[])){
      const r = sim.applyCmd(seat, c);
      if(r) res.push({seat, cmd:c, rec:r});
    }
    for(const h of sim.hunters){ sim.moveHunter(h, sim.MP_TICK); sim.hunterNoise(h, sim.MP_TICK); }
    const per = sim.step(sim.MP_TICK);
    for(const h of sim.hunters) h.cmd = null;   // a move lasts ONE tick
    return {per, res};
  };
  /* the MP fingerprint hashes what every client must agree on — the world
     AND every seat — but NOT the personal ledgers (honor, doctrine, kit),
     which are each client's own business by design. */
  sim.mpFingerprint = function(){
    const v=[sim.simSec, sim.frame||0, sim.Q.x, sim.Q.z, sim.Q.awareness,
             sim.Q.state==='CHARGE'?1:0, sim.Q.wary, sim.Q.alive?1:0,
             sim.wind.dir, sim.pendingLossSeat==null?-1:sim.pendingLossSeat];
    for(const h of sim.hunters) v.push(h.x, h.z, h.noise, h.bleed, h.cloaked?1:0);
    for(const c of sim.fauna) v.push(c.x, c.z, c.alive?1:0, c.awareness, c.hunger||0);
    let hsh=5381;
    for(const n of v){ hsh=((hsh*33) ^ Math.round((+n||0)*10000)) >>> 0; }
    return hsh;
  };

  /* ⚠️ `by` is WHICH ANIMAL opened you up, and it defaults to the player's
     quarry. Once M5 put predators in the world this stopped being a
     formality: an apex mauling you was resetting the STILT-GRAZER's spook
     count and marking it as having drawn your blood. Only the animal that
     actually hit you gets the nemesis state. */
  sim.woundHunter = function(cause, by){
    const H=sim.hunter, Q=by || sim.Q;
    H.bleed = BLEED_HOURS/24*DAY_SEC;
    H.bleeds++;
    Q.drewBlood = true;
    Q.charging=false; Q.gone=false;
    Q.state='FLEE'; Q.stateT=0;
    /* agitated but not fled: just under SPOOK, and primed to come again */
    Q.awareness = Math.min(Q.awareness, SPOOK_AT-0.03);
    Q.alertState = 'ALERT';
    if(Q===sim.Q) Q.spooks = 2;
    Q.wary = Math.min(3,(Q.wary||0)+1);
    return {tier:'bleeding', cause, by:Q.species, bleed:H.bleed,
            bleeds:H.bleeds, wary:Q.wary};
  };

  /* TIER 2 — IT BREAKS YOU. Only ever while you are already bleeding. */
  sim.breakHunter = function(cause, by){
    const H=sim.hunter, Q=by || sim.Q, p=sim.player, rng=world.rng;
    H.breaks++;

    /* THE SCAR CREDIT (S4): a failed honorable attempt still earns honor,
       ~30% of the kill's value scaled by how exposed you made yourself.
       The cloak earns exactly ZERO by definition - you were never exposed,
       so there is no scar. The credit lands where the failures land and
       they cancel. Scoring is M2's job; the wound only records the debt. */
    const conceal = world.coverAt(p.x,p.z)*(p.crouch?0.92:0.45);
    const exposure = p.cloaked ? 0 : Math.max(0, Math.min(1, 1-conceal));
    const credit = 0.30*exposure;
    H.scarCredit += credit; H.scars++;

    /* the injury. It STACKS, so a run of bad hunts compounds - and a hunter
       already gutted takes the next one worse (low constitution). */
    const mod=sim.hunterMods();
    const key=INJURY_KEYS[Math.floor(rng()*INJURY_KEYS.length)];
    const cur=H.injuries[key];
    const sev=Math.min(3,(cur?cur.sev:0)+1);
    H.injuries[key]={ sev, left: INJURIES[key].days*DAY_SEC*(0.7+sev*0.3)/mod.con };

    /* ⚠️ IT KEEPS SOMETHING OF YOURS — AND YOU CHOOSE WHICH (Kyle, 2026-08-11;
       bible §17 Q1, previously unresolved). No RNG here on purpose: deciding
       what you can least afford to lose, on the ship, injured, IS the moment.
       The sim only offers the options; resolveLoss() commits it — the same
       shape as Empire's aftermath spoils. */
    const pool=KIT_TAKEABLE.filter(k=>H.kit[k]);
    H.pendingLoss = pool.length ? {options:pool} : null;

    /* you were out for hours. The world did not wait: sign cooled, the day
       moved on, and your injuries had that long to start closing. */
    const blackout=(4.5+rng()*4.5)/24*DAY_SEC/mod.con;
    sim.advanceTime(blackout);

    /* you wake on the ship */
    p.x=sim.ship.x; p.z=sim.ship.z; p.moving=false; p.crouch=false;
    p.slow=false; p.cloaked=false; p.noise=0; p.spears=3;

    /* THE NEMESIS: it does not die and it does not despawn. It stays on this
       world, carrying your gear, and it has learned what you are. */
    Q.gone=false; Q.charging=false; Q.spooks=0; Q.awareness=0; Q.riseFilter=0;
    Q.alertState='CALM'; Q.state='TRAVEL'; Q.stateT=0; Q.speed=0;
    Q.wary=Math.min(3,(Q.wary||0)+1);
    const want=sim.zoneForTime(), lim=WORLD_SIZE*0.47;
    Q.x=Math.max(-lim,Math.min(lim, want.z.x+(rng()-0.5)*46));
    Q.z=Math.max(-lim,Math.min(lim, want.z.z+(rng()-0.5)*46));

    /* the bleeding is over — it closed while you were out. What is left is
       the injury, which is permanent-ish, and the choice still to make. */
    H.bleed=0;

    const ev={tier:'broken', cause, injury:key, sev, blackout, credit, exposure,
              breaks:H.breaks, wary:Q.wary,
              options:H.pendingLoss?H.pendingLoss.options.slice():[]};
    H.lastBreak=ev;
    return ev;
  };

  /* You decide what it keeps. Deterministic (a player choice, never a roll)
     and idempotent, so a double-click cannot cost you two pieces of kit. */
  sim.resolveLoss = function(key){
    const H=sim.hunter;
    if(!H.pendingLoss) return null;
    if(!H.pendingLoss.options.includes(key)) return null;
    H.pendingLoss=null;
    H.kit[key]=false; H.taken.push(key); sim.Q.carrying=key;
    if(H.lastBreak) H.lastBreak.took=key;
    return key;
  };

  /* ---------- save / restore ----------
     Invariant 3: everything persistent round-trips. The rng cursor goes with
     it or nothing after a load is reproducible. */
  sim.saveState = function(){
    return JSON.stringify({
      /* ⚠️ the ground key MUST ride in the save — loadSim rebuilds the world
         from seed, and without it an Old Ground reloads as a ROLLED world */
      v:1, seed, profileKey, ground: sim.groundKey,
      simSec:sim.simSec, frame:sim.frame, rng:world.rng.save(),
      wind:{...sim.wind}, player:{...sim.player}, Q:{...sim.Q},
      ship:{...sim.ship},
      hunter:{ kit:{...sim.hunter.kit},
               injuries:JSON.parse(JSON.stringify(sim.hunter.injuries)),
               breaks:sim.hunter.breaks, scars:sim.hunter.scars,
               scarCredit:sim.hunter.scarCredit,
               lastBreak:sim.hunter.lastBreak?{...sim.hunter.lastBreak}:null,
               taken:[...sim.hunter.taken],
               bleed:sim.hunter.bleed, bleeds:sim.hunter.bleeds,
               pendingLoss:sim.hunter.pendingLoss
                 ?{options:[...sim.hunter.pendingLoss.options]}:null,
               doctrine:sim.hunter.doctrine, honor:sim.hunter.honor,
               standing:sim.hunter.standing, everHadCloak:sim.hunter.everHadCloak,
               primary:sim.hunter.primary, gear:{...sim.hunter.gear},
               badBlood:sim.hunter.badBlood, disgrace:sim.hunter.disgrace,
               fall:sim.hunter.fall, clanKills:sim.hunter.clanKills,
               bounty:sim.hunter.bounty, voids:sim.hunter.voids,
               gaveGround:sim.hunter.gaveGround,
               trophies:JSON.parse(JSON.stringify(sim.hunter.trophies)),
               lastApproach:{...sim.hunter.lastApproach},
               approachRun:{...sim.hunter.approachRun} },
      tracks:sim.tracks.map(t=>({x:t.x,z:t.z,age:t.age})),
      /* ⚠️ THE COLONY MUST ROUND-TRIP (invariant 3). It is regenerated by
         createSim from the seed, but WHERE everyone has walked to, who is
         dead, and who is alarmed are all deltas the seed cannot know — a
         reload without this diverges immediately. */
      /* ⚠️ SAME KEY ORDER AS setupColony builds it. Round-trip checks compare
         JSON strings, and a reordered-but-identical object fails them for no
         real reason — which wastes a debugging round every time. */
      colony: sim.colony ? { x:sim.colony.x, z:sim.colony.z,
        name:sim.colony.name,
        people: sim.colony.people.map(q=>({...q, home:{...q.home}})),
        alarm:sim.colony.alarm } : null,
      witnessT: sim.witnessT, unseenT: sim.unseenT,
      clan: sim.clan ? {...sim.clan} : null,
      /* ⚠️ fauna were NEVER saved — a latent invariant-3 hole that only
         stayed invisible because the fingerprint doesn't hash them. Wounds
         made it visible: a bleeding beast has to still be bleeding, in the
         same place, after a reload. Blood sign and carrion ride along. */
      fauna: sim.fauna.map(f=>({...f})),
      blood: sim.blood.map(b=>({...b})),
      carrion: sim.carrion.map(k=>({...k}))
    });
  };
  sim.restoreState = function(json){
    const s=typeof json==='string'?JSON.parse(json):json;
    if(s.seed!==seed) throw new Error('save is from a different world');
    sim.simSec=s.simSec; sim.frame=s.frame; world.rng.load(s.rng);
    Object.assign(sim.wind,s.wind);
    Object.assign(sim.player,s.player);
    Object.assign(sim.Q,s.Q);
    Object.assign(sim.ship,s.ship);
    sim.hunter.kit={...s.hunter.kit};
    sim.hunter.injuries=JSON.parse(JSON.stringify(s.hunter.injuries));
    sim.hunter.breaks=s.hunter.breaks; sim.hunter.scars=s.hunter.scars;
    sim.hunter.scarCredit=s.hunter.scarCredit;
    sim.hunter.lastBreak=s.hunter.lastBreak?{...s.hunter.lastBreak}:null;
    sim.hunter.taken=[...s.hunter.taken];
    sim.hunter.bleed=s.hunter.bleed||0;
    sim.hunter.bleeds=s.hunter.bleeds||0;
    sim.hunter.pendingLoss=s.hunter.pendingLoss
      ?{options:[...s.hunter.pendingLoss.options]}:null;
    sim.hunter.doctrine=s.hunter.doctrine;
    sim.hunter.standing=s.hunter.standing||0;
    sim.hunter.everHadCloak=!!s.hunter.everHadCloak;
    sim.hunter.primary=s.hunter.primary||'spears';
    sim.hunter.gear={...(s.hunter.gear||{})};
    sim.hunter.badBlood=!!s.hunter.badBlood;
    sim.hunter.disgrace=s.hunter.disgrace||0;
    sim.hunter.fall=s.hunter.fall||'good';
    sim.hunter.clanKills=s.hunter.clanKills||0;
    sim.hunter.honor=s.hunter.honor||0; sim.hunter.bounty=s.hunter.bounty||0;
    sim.hunter.voids=s.hunter.voids||0;
    sim.hunter.gaveGround=!!s.hunter.gaveGround;
    sim.hunter.trophies=JSON.parse(JSON.stringify(s.hunter.trophies||[]));
    sim.hunter.lastApproach={...(s.hunter.lastApproach||{})};
    sim.hunter.approachRun={...(s.hunter.approachRun||{})};
    sim.tracks=s.tracks.map(t=>({x:t.x,z:t.z,age:t.age}));
    sim.colony = s.colony ? { x:s.colony.x, z:s.colony.z, name:s.colony.name,
      people:s.colony.people.map(q=>({...q, home:{...q.home}})),
      alarm:s.colony.alarm } : null;
    sim.witnessT = s.witnessT||0; sim.unseenT = s.unseenT||0;
    sim.clan = s.clan ? {...s.clan} : null;
    if(s.fauna){
      sim.fauna = s.fauna.map(f=>({...f}));
      /* fauna[0] IS the quarry — keep the alias true after a load */
      Object.assign(sim.Q, sim.fauna[0]); sim.fauna[0]=sim.Q;
    }
    if(s.blood)   sim.blood   = s.blood.map(b=>({...b}));
    if(s.carrion) sim.carrion = s.carrion.map(k=>({...k}));
    return sim;
  };

  /* ============================================================
     THE CALL (§3) — "honorable; a call does not remove the beast's chance
     to detect you." Sold as CALL REEDS in the market since M8, with nothing
     behind them until now. A CALM quarry in earshot drifts toward the sound
     to investigate — with every sense still working. You are inviting the
     thing that can kill you to come closer. That is the whole deal.
     ============================================================ */
  sim.callQuarry = function(from){
    const Q=sim.Q, p=from||sim.player;
    if(!Q.alive || Q.gone) return {answered:false, why:'nothing to hear it'};
    const d=Math.hypot(Q.x-p.x, Q.z-p.z);
    if(d>140) return {answered:false, why:'too far'};
    if(Q.alertState!=='CALM') return {answered:false, why:'it is not fooled'};
    Q.curious={x:p.x, z:p.z, t:26};
    return {answered:true, d};
  };

  /* skip to the next phase. The world does NOT pause. */
  sim.restSkip = function(){
    if(sim.player.moving) return null;
    const before=sim.phaseName(), h=sim.todHours();
    let nb=24;
    for(const [n,a] of PHASES) if(a>h && a<nb) nb=a;
    const adv=(nb-h)/24*DAY_SEC;
    sim.advanceTime(adv+1);
    sim.Q.stateT += adv;
    return {before, after:sim.phaseName()};
  };

  /* ============================================================
     M5 — THE BIOSPHERE
     A food web that runs whether or not you are watching. Predators hunt
     grazers, scavengers come to carrion, apexes contest each other's turf,
     and two of them will hunt YOU. Being hunted is not a failure state.

     ⚠️ `sim.Q` stays exactly what it was — it is fauna[0], the animal the
     player is nominally after. Everything here is ADDITIVE, so the whole M1
     stalk (which is the part that has to feel good) is untouched.
     ============================================================ */
  sim.fauna = [];
  sim.carrion = [];

  function spawnCreature(key, isQ){
    const sp = sim.species[key];
    const zone = [world.zones.feed, world.zones.water, world.zones.bed][
      Math.floor(world.rng()*3)];
    const c = isQ ? sim.Q : {
      x: zone.x + (world.rng()-0.5)*46, z: zone.z + (world.rng()-0.5)*46,
      facing: world.rng()*6.28, state:'GRAZE', stateT:0, speed:0,
      alive:true, gone:false, awareness:0, alertState:'CALM',
      species:key, tier:sp.tier, specimenPct:0, gravid:false,
      everAware:false, strikes:0, drewBlood:false, wary:0, carrying:null,
      quarryInitiated:false, quarryDisengaged:false, cycleSeen:{},
      charging:false, chargeAim:0, assessed:false, riseFilter:0,
      blood:1, bleedRate:0, wound:null, dieT:0, lastBlood:0,
      /* ⚠️ below the 0.35 hunt threshold on purpose — spawning a predator
         already hungry meant the world opened with a kill on frame one */
      target:null, hunger:world.rng()*0.28, fed:0
    };
    /* ⚠️ fauna[0] IS sim.Q, built in the object literal above, so it does not
       have the food-web fields. Give them to it or `hunger` is undefined and
       every arithmetic touch of it produces NaN. */
    if(c.hunger===undefined){ c.hunger=0; c.fed=0; c.target=null; }
    if(!isQ){
      c.specimenPct = rollSpecimen(world.rng, sp.namedChance);
      c.gravid = world.rng() < sp.gravidChance;
      c.named = c.specimenPct >= NAMED_PCT ? nameTheNamed(world.rng, wgen.biome) : null;
      const lim=WORLD_SIZE*0.47;
      c.x=Math.max(-lim,Math.min(lim,c.x)); c.z=Math.max(-lim,Math.min(lim,c.z));
    }
    sim.fauna.push(c);
    return c;
  }

  sim.populate = function(){
    sim.fauna.length = 0; sim.carrion.length = 0;
    spawnCreature(sim.Q.species, true);              // fauna[0] IS the quarry
    for(const key of Object.keys(sim.wgen.population)){
      const n = sim.wgen.population[key] - (key===sim.Q.species ? 1 : 0);
      for(let i=0;i<n;i++) spawnCreature(key, false);
    }
  };

  const HUNT_RANGE = 46, EAT_RANGE = 2.6, TURF_RANGE = 16;

  function updateCreature(c, dt){
    sim.tickWound(c, dt);
    if(!c.alive || c.gone) return;
    if(c.state==='BEDDED'){ c.speed=0; return; }
    /* M12: fauna react to the NEAREST of the party */
    const sp = sim.species[c.species], p = sim.nearestHunter(c.x, c.z);
    c.stateT += dt;
    /* ⚠️ HUNGER IS AN IN-WORLD-DAY CLOCK, NOT A MINUTE ONE. At 0.004/s a
       predator starved in 90 seconds and therefore killed every 90 seconds —
       two of them emptied the board of grazers in under three in-world hours
       and the "stable food web" soak passed on a dead world. At 0.0002 an
       apex eats roughly once every 8 in-world hours, which is an animal. */
    c.hunger = Math.min(1, c.hunger + dt*0.0002);

    /* --- does it know about YOU? A cheap sense: noise and distance, weighted
       by its own profile. The full three-channel model runs only for the
       player's quarry; twelve creatures do not each need a terrain raymarch. */
    const prof = PROFILES[sp.profile];
    const dp = Math.hypot(c.x-p.x, c.z-p.z);
    const stim = Math.max(0, 1 - dp/(12 + p.noise*prof.hearRange)) * p.noise
               * (p.cloaked ? 0.35 : 1);
    if(stim > STIM_FLOOR){ c.awareness = Math.min(1, c.awareness + stim*RISE_RATE*dt); }
    else c.awareness = Math.max(0, c.awareness - DECAY_RATE*dt);
    c.alertState = c.awareness>=SPOOK_AT ? 'SPOOKED'
                 : c.awareness>=ALERT_AT ? 'ALERT' : 'CALM';
    if(c.alertState!=='CALM') c.everAware = true;

    let tx=c.x, tz=c.z, spd=sp.speed;

    /* --- PREDATORS --- */
    if(sp.eats === 'meat'){
      /* ⚠️ AND IT HUNTS BACK. An apex that has noticed you and is hungry
         treats you as prey. Being hunted is the point, not a fail state. */
      const huntsPlayer = c.awareness > ALERT_AT && c.hunger > 0.45 && dp < HUNT_RANGE;
      let prey = huntsPlayer ? {x:p.x, z:p.z, isPlayer:true, h:p} : null;
      if(!prey){
        let best=1e9;
        for(const o of sim.fauna){
          if(o===c || !o.alive || o.gone) continue;
          if(sim.species[o.species].eats === 'meat') continue;    // not each other
          const d = Math.hypot(o.x-c.x, o.z-c.z);
          if(d < best && d < HUNT_RANGE){ best=d; prey=o; }
        }
      }
      if(prey && c.hunger > 0.35){
        c.state='STALK'; c.target=prey.isPlayer?'player':prey.species;
        tx=prey.x; tz=prey.z;
        spd = sp.speed * (c.hunger>0.75 ? 1.9 : 1.2);
        const d = Math.hypot(prey.x-c.x, prey.z-c.z);
        if(d < EAT_RANGE){
          if(prey.isPlayer){
            /* the two-tier wound, from the other side of the food web —
               and THIS animal is the one that becomes your nemesis */
            sim.strikeSeat(prey.h || sim.player, 'hunted', c);
            c.hunger = Math.max(0, c.hunger-0.5);
          } else {
            prey.alive=false; prey.gone=true;
            /* ⚠️ if that was YOUR wounded quarry, §5 applies: something else
               finished it, and the trophy you were tracking is gone */
            if(prey.wound && prey.wound.ctx){
              const rec=trophyScore({...prey.wound.ctx, scavenged:true});
              rec.bounty=0; rec.species=(sim.species[prey.species]||{}).label||'—';
              rec.at=sim.simSec; rec.trailed=true;
              sim.bankTrophy(rec); sim.claimed=rec; prey.wound=null;
            }
            sim.carrion.push({x:prey.x, z:prey.z, age:0, species:prey.species,
                              claimed:false});
            c.hunger = Math.max(0, c.hunger-0.7); c.fed++;
            c.state='REST'; c.stateT=0;
          }
        }
      } else { c.state='TRAVEL'; }

      /* TURF — two meat-eaters too close is a contest, and it is something
         you FIND, not something staged for you */
      for(const o of sim.fauna){
        if(o===c || !o.alive || o.gone) continue;
        if(sim.species[o.species].eats !== 'meat') continue;
        const d=Math.hypot(o.x-c.x,o.z-c.z);
        if(d < TURF_RANGE && d > 0.1){
          const mine = sim.species[c.species].threat, theirs = sim.species[o.species].threat;
          if(mine < theirs){                       // the lesser one yields
            c.state='TURF'; tx = c.x + (c.x-o.x); tz = c.z + (c.z-o.z);
            spd = sp.speed*1.4;
          }
        }
      }
    }
    /* --- SCAVENGERS follow the dead --- */
    else if(sp.eats === 'carrion'){
      let best=1e9, target=null, ti=-1;
      for(let k=0;k<sim.carrion.length;k++){
        const kk=sim.carrion[k];
        if(kk.age > 900) continue;
        const d=Math.hypot(kk.x-c.x, kk.z-c.z);
        if(d<best && d<HUNT_RANGE*1.6){ best=d; target=kk; ti=k; }
      }
      if(target){
        c.state='TRAVEL'; tx=target.x; tz=target.z; spd=sp.speed*1.4;
        if(best < EAT_RANGE){
          c.state='FEED'; target.claimed=true;
          /* ⚠️ a carcass gets EATEN, it is not an infinite trough. Feeding
             every tick while standing on it produced 69,086 "feeds" in one
             soak and made the scavenger stat meaningless. */
          target.eaten = (target.eaten||0) + dt;
          if(target.eaten > 90){ sim.carrion.splice(ti,1);
            c.hunger=Math.max(0,c.hunger-0.6); c.fed++; }
        }
      } else c.state='TRAVEL';
    }

    /* --- everything falls back to the need-zone schedule --- */
    if(c.state==='TRAVEL' || c.state==='GRAZE' || c.state==='DRINK' || c.state==='BED'){
      const want = sim.zoneForTime();
      tx = want.z.x; tz = want.z.z;
      const dz = Math.hypot(c.x-tx, c.z-tz);
      if(dz < 9){ c.state = want.s; spd = sp.speed*0.25; }
      else spd = sp.speed;
    }
    /* --- and everything runs from a spooked contact ---
       a wounded ANYTHING runs, even a predator: it knows what a spear is now */
    if(c.alertState==='SPOOKED' && (sp.eats!=='meat' || c.wound)){
      const ax=c.x-p.x, az=c.z-p.z, l=Math.hypot(ax,az)||1;
      tx=c.x+ax/l*30; tz=c.z+az/l*30; spd=sp.flee; c.state='FLEE';
    }
    if(c.wound){
      if(c.wound.part==='leg') spd *= WOUNDS.leg.cripple;
      spd *= 0.45 + 0.55*c.blood;
    }

    const dx=tx-c.x, dz2=tz-c.z, L=Math.hypot(dx,dz2);
    if(L>0.4){
      c.x += dx/L*spd*dt; c.z += dz2/L*spd*dt;
      let da=Math.atan2(dx/L,dz2/L)-c.facing;
      while(da>Math.PI)da-=Math.PI*2; while(da<-Math.PI)da+=Math.PI*2;
      c.facing += da*Math.min(1,dt*3);
      c.speed = spd;
    } else c.speed = 0;
    const lim=WORLD_SIZE*0.47;
    c.x=Math.max(-lim,Math.min(lim,c.x)); c.z=Math.max(-lim,Math.min(lim,c.z));
  }

  /* ============================================================
     THE WOUND TICK — shared by the quarry and every other creature.
     Bleeding is a clock: blood 1→0, speed falls with it, at BED_AT the
     beast lies down, and BED_DIE_T later it dies WHERE THE TRAIL ENDS.
     ============================================================ */
  sim.tickWound = function(c, dt){
    if(!c.alive || !c.wound) return;
    if(c.bleedRate > 0){
      c.blood = Math.max(0, c.blood - c.bleedRate*dt);
      /* a leg wound CLOTS — the beast survives, crippled and wiser.
         "escapes wounded, remembers your scent, appreciates in value" (§11) */
      if(c.wound.part==='leg' && c.blood <= WOUNDS.leg.clotAt){
        c.bleedRate = 0;
        c.wary = Math.min(3,(c.wary||0)+1);
        c.specimenPct = Math.min(1.5, (c.specimenPct||0)+0.08);
      }
      /* blood sign: bright and frequent when heavy, dark and sparse when not */
      if(c.speed > 0.3 && sim.simSec-(c.lastBlood||0) > (c.bleedRate>0.008?1.1:2.2)){
        c.lastBlood = sim.simSec;
        sim.blood.push({x:c.x, z:c.z, age:0,
                        sev:c.bleedRate>0.008?1:WOUNDS[c.wound.part].sev});
        if(sim.blood.length>BLOOD_MAX) sim.blood.shift();
      }
    }
    if(c.wound.part==='gut' && c.blood<=BED_AT && c.state!=='BEDDED' && c.alive){
      c.state='BEDDED'; c.dieT=BED_DIE_T; c.speed=0;
    }
    if(c.state==='BEDDED'){
      c.dieT -= dt;
      if(c.dieT<=0){
        c.alive=false; c.gone=false;
        /* it died of YOUR wound: the carcass carries the pending reckoning,
           and you have to FIND it before something else does */
        sim.carrion.push({x:c.x, z:c.z, age:0, species:c.species,
          claimed:false, claim: c.wound.ctx ? {ctx:c.wound.ctx} : null});
      }
    }
  };

  /* ⚠️ WITHOUT RECRUITMENT THE WEB IS NOT A WEB, IT IS A COUNTDOWN.
     Fixed populations plus predation means the apex eats every grazer and
     the world goes silent — a soak would "pass" with zero errors on a dead
     board. Prey recruit back toward their trophic target (the herd moves in
     from off-map), slowly, and predators recruit far more slowly because
     energy thins as it climbs. This is what makes an 8-hour soak meaningful. */
  const RECRUIT_EVERY = DAY_SEC/6;      // ~4 in-world hours
  let recruitT = 0;
  sim.recruit = function(){
    const count = {};
    for(const f of sim.fauna) if(f.alive && !f.gone)
      count[f.species] = (count[f.species]||0)+1;
    for(const key of Object.keys(sim.wgen.population)){
      const sp=sim.species[key], have=count[key]||0, want=sim.wgen.population[key];
      if(have >= want) continue;
      /* meat-eaters come back at a quarter the rate of what they eat */
      if(sp.eats==='meat' && world.rng() > 0.25) continue;
      /* reuse a dead slot so the array cannot grow without bound */
      const dead = sim.fauna.findIndex((f,i)=> i>0 && (!f.alive||f.gone) && f.species===key);
      if(dead >= 0){
        const zone=[world.zones.feed,world.zones.water][Math.floor(world.rng()*2)];
        const c=sim.fauna[dead], lim=WORLD_SIZE*0.47;
        c.alive=true; c.gone=false; c.awareness=0; c.alertState='CALM';
        c.state='TRAVEL'; c.stateT=0; c.hunger=world.rng()*0.4;
        c.everAware=false; c.strikes=0; c.drewBlood=false; c.wary=0;
        c.specimenPct=rollSpecimen(world.rng, sp.namedChance);
        c.gravid=world.rng()<sp.gravidChance;
        c.x=Math.max(-lim,Math.min(lim, zone.x+(world.rng()-0.5)*60));
        c.z=Math.max(-lim,Math.min(lim, zone.z+(world.rng()-0.5)*60));
      } else spawnCreature(key, false);
      break;                              // one recruit per window, no floods
    }
  };

  sim.updateFauna = function(dt){
    for(let i=1;i<sim.fauna.length;i++) updateCreature(sim.fauna[i], dt);
    for(const k of sim.carrion) k.age += dt;
    /* carrion rots away; the board does not fill up with meat forever */
    for(let i=sim.carrion.length-1;i>=0;i--)
      if(sim.carrion[i].age > 2600) sim.carrion.splice(i,1);
    recruitT += dt;
    if(recruitT >= RECRUIT_EVERY){ recruitT = 0; sim.recruit(); }
  };

  /* ============================================================
     M10 — THE CLAN HUNTER
     ⚠️ NOT AN ANIMAL. It hunts the way YOU do: it reads your noise and your
     scent, it closes on cover, it CLOAKS at range and drops the cloak to
     strike — because a hunter that used the cloak for the kill would be
     scoring Butchery, and they are here to do this properly.
     The hardest and highest-scoring quarry in the game (§11).
     ============================================================ */
  sim.clan = null;
  const CLAN = { speed:4.6, sprint:7.4, reach:3.2, strikeCd:2.6,
                 cloakRange:26, hunt:150, patience:0.55 };

  sim.spawnClanHunter = function(){
    /* M12: Bad Blood is a PERSONAL spiral — per-client disgrace would desync
       the spawn, so the clan hunter never walks into a shared hunt */
    if(sim.mp) return null;
    if(sim.clan) return sim.clan;
    const rng=world.rng, lim=WORLD_SIZE*0.42;
    /* they arrive at the edge of your world and walk in */
    const a=rng()*Math.PI*2;
    sim.clan = {
      x:Math.max(-lim,Math.min(lim,Math.sin(a)*lim)),
      z:Math.max(-lim,Math.min(lim,Math.cos(a)*lim)),
      facing:a+Math.PI, state:'SEEK', stateT:0, speed:0,
      alive:true, cloaked:true, strikeT:0, awareness:0,
      name:'A HUNTER OF YOUR OWN CLAN', struck:0
    };
    return sim.clan;
  };
  sim.despawnClanHunter = function(){ sim.clan=null; };

  sim.updateClan = function(dt){
    const C=sim.clan; if(!C || !C.alive) return null;
    const p=sim.nearestHunter(C.x, C.z);
    C.stateT+=dt; if(C.strikeT>0) C.strikeT-=dt;
    const d=Math.hypot(C.x-p.x, C.z-p.z);

    /* it reads you on the same channels you read a beast on */
    const noise=p.noise, scent=sim.scentAt(C.x,C.z);
    const lead = Math.max(0, 1-d/CLAN.hunt) * (0.35 + noise*0.8 + scent*0.6);
    C.awareness = Math.min(1, Math.max(0, C.awareness + (lead>0.12? dt*0.45 : -dt*0.12)));

    /* ⚠️ IT DROPS THE CLOAK TO STRIKE. A clan hunter that killed you from
       under a cloak would be taking Butchery, and it did not come here for
       that — this is the same code of honour the player is scored against. */
    C.cloaked = d > CLAN.cloakRange && C.awareness < 0.85;

    let broke=null;
    if(C.awareness > 0.25){
      C.state = d < 14 ? 'CLOSE' : 'STALK';
      const spd = d < 14 ? CLAN.sprint : CLAN.speed;
      const ax=p.x-C.x, az=p.z-C.z, l=Math.hypot(ax,az)||1;
      C.x += ax/l*spd*dt; C.z += az/l*spd*dt;
      C.facing = Math.atan2(ax,az);
      C.speed = spd;
      if(d <= CLAN.reach && C.strikeT<=0){
        C.strikeT = CLAN.strikeCd; C.struck++;
        broke = sim.strikeSeat(p, 'clan');
      }
    } else {
      /* casting for your trail */
      C.state='SEEK';
      if(C.stateT>4){ C.stateT=0; C.facing += (world.rng()-0.5)*2.2; }
      C.x += Math.sin(C.facing)*CLAN.speed*0.55*dt;
      C.z += Math.cos(C.facing)*CLAN.speed*0.55*dt;
      C.speed = CLAN.speed*0.55;
    }
    const lim=WORLD_SIZE*0.47;
    C.x=Math.max(-lim,Math.min(lim,C.x)); C.z=Math.max(-lim,Math.min(lim,C.z));
    return broke;
  };

  /* Killing one is the fastest way back — and it is worth more than anything
     else you can put on the wall. */
  sim.strikeClan = function({dist, part='body'}){
    const C=sim.clan, H=sim.hunter;
    if(!C || !C.alive) return {miss:true};
    C.alive=false;
    const rec = trophyScore({
      tier:'legendary', specimenPct:NAMED_PCT,
      method: sim.player.cloaked ? 'butchery'
            : dist<=CLAN.reach ? (sim.hunter.bleed>0?'contest':'closework') : 'clean',
      integrity: part==='skull'?INTEGRITY.skull:INTEGRITY.clean,
      party:1, consecutive:0, doctrine:H.doctrine, cycleObserved:true, strikes:1
    });
    rec.species='A HUNTER OF YOUR OWN CLAN'; rec.clan=true;
    rec.disgraceBefore = H.disgrace;
    rec.bounty = 0;                       // nobody buys a clan hunter's body
    rec.at=sim.simSec; rec.dist=dist; rec.part=part;
    H.trophies.push(rec);
    H.honor += rec.score; H.clanKills++;
    /* ⚠️ REDEMPTION IS REAL AND MECHANICAL — carried by the trophy's own
       `clan` flag through disgrace(), NOT by padding the shelf with filler.
       Bad Blood is a chapter, not a fail state. */
    H.standing = standing(H.trophies);
    H.disgrace = disgrace(H.trophies);
    const f=fallOf(H.disgrace); H.fall=f.key; H.badBlood=!!f.hunted;
    rec.disgrace=H.disgrace; rec.fall=f;
    rec.redeemed = H.disgrace < (rec.disgraceBefore ?? 1);
    sim.lastReckoning = rec;
    sim.clan=null;
    return rec;
  };

  /* ============================================================
     M11 — THE WORTHY
     A settlement, and the hardest rule in the game to keep.
     ============================================================ */
  sim.colony = null;
  sim.witnessT = 0;          // seconds an unworthy has had clear sight of you
  sim.unseenT  = 0;          // seconds since the last one lost you

  sim.setupColony = function(){
    const cfg = colonyFor(seed);
    if(!cfg) return null;
    const rng = world.rng, lim = WORLD_SIZE*0.40;
    /* put it somewhere flat-ish and away from the quarry's feed ground */
    const cx = Math.max(-lim,Math.min(lim, world.zones.water.x + (rng()-0.5)*70));
    const cz = Math.max(-lim,Math.min(lim, world.zones.water.z + (rng()-0.5)*70));
    const people = cfg.roster.map((kind,i)=>{
      const a = i/cfg.roster.length*Math.PI*2 + rng()*0.6;
      const r = cfg.spread*(0.35+rng()*0.65);
      return { kind, x:Math.max(-lim,Math.min(lim,cx+Math.sin(a)*r)),
               z:Math.max(-lim,Math.min(lim,cz+Math.cos(a)*r)),
               facing:rng()*6.28, alive:true, alert:0, shootT:0,
               state:'WORK', stateT:rng()*4, home:{x:cx,z:cz} };
    });
    sim.colony = { x:cx, z:cz, name:cfg.name, people, alarm:0 };
    return sim.colony;
  };

  sim.updateColony = function(dt){
    const C = sim.colony; if(!C) return null;
    const seatSeen = sim.hunters.map(()=>false);
    let broke = null;
    if(C.alarm > 0) C.alarm -= dt;

    for(const q of C.people){
      if(!q.alive) continue;
      q.stateT += dt; if(q.shootT>0) q.shootT -= dt;
      const K = KINDS[q.kind];

      /* ⚠️ THEY HEAR YOU TOO. Sight-only detection deadlocked: colonists walk
         along their facing, so the player ends up permanently behind them and
         a settlement could be stood next to at noise 0.92 without one of them
         ever turning round. Every quarry perceives on three channels (§3) —
         people are not an exception.
         M12: each colonist reads EVERY hunter and engages the most exposed
         one; being SEEN marks that seat, not the whole party. */
      let p=sim.hunters[0], d=0, los=false, sees=false, heard=0, best=-Infinity;
      for(const h of sim.hunters){
        const hd  = Math.hypot(q.x-h.x, q.z-h.z);
        const hy  = world.heightAt(h.x,h.z)+(h.crouch?1.05:1.7);
        const hlos = world.hasLOS(q.x, world.heightAt(q.x,q.z)+1.7, q.z, h.x, hy, h.z);
        const hsees  = seenBy(q, h, hd, hlos);
        const hheard = Math.max(0, 1 - hd/(10 + h.noise*46)) * h.noise * (h.cloaked?0.6:1);
        if(hsees && !K.valid) seatSeen[h.seat] = true;
        const score = (hsees?2:0) + hheard - hd*1e-6;
        if(score > best){ best=score; p=h; d=hd; los=hlos; sees=hsees; heard=hheard; }
      }
      if(sees || heard > 0.22){
        q.alert = Math.min(1, q.alert + dt*(sees?0.9:0.45));
        /* ⚠️ COORDINATION: one who notices you tells everyone in earshot. This
           is what makes a settlement dangerous rather than a queue of targets. */
        /* ⚠️ same threshold as `roused` below — at 0.5 here and 0.4 there, a
           colonist could open fire without ever raising the alarm */
        if(q.alert > 0.4) C.alarm = Math.max(C.alarm, 12);
        /* ...but only being SEEN makes you witnessed. Hearing a noise is not
           witnessing what you are, and the void is about being SEEN —
           per-seat, marked in the hunter scan above. */
        /* something heard turns to look */
        if(!sees && heard>0.22) q.facing = Math.atan2(p.x-q.x, p.z-q.z);
      } else q.alert = Math.max(0, q.alert - dt*0.35);

      const roused = q.alert > 0.4 || C.alarm > 0;

      if(!roused){                            // going about their day
        if(q.stateT > 5){ q.stateT = 0; q.facing += (world.rng()-0.5)*2.4; }
        q.x += Math.sin(q.facing)*K.speed*0.25*dt;
        q.z += Math.cos(q.facing)*K.speed*0.25*dt;
        q.state='WORK';
      } else if(K.valid){                     // ARMED: converge and shoot back
        q.state = d < ENGAGE_RANGE ? 'FIRING' : 'CLOSING';
        const ax=p.x-q.x, az=p.z-q.z, l=Math.hypot(ax,az)||1;
        q.facing = Math.atan2(ax,az);
        if(d > ENGAGE_RANGE*0.6){ q.x += ax/l*K.speed*dt; q.z += az/l*K.speed*dt; }
        if(d < ENGAGE_RANGE && los && q.shootT<=0 && !p.cloaked){
          q.shootT = SHOOT_CD;
          /* they hit you through the same two tiers everything else does */
          broke = sim.strikeSeat(p, 'colonist');
        }
      } else {                                // UNWORTHY: run, and remember
        q.state='FLEEING';
        const ax=q.x-p.x, az=q.z-p.z, l=Math.hypot(ax,az)||1;
        q.facing = Math.atan2(ax,az);
        q.x += ax/l*K.speed*dt; q.z += az/l*K.speed*dt;
      }
      const lim=WORLD_SIZE*0.47;
      q.x=Math.max(-lim,Math.min(lim,q.x)); q.z=Math.max(-lim,Math.min(lim,q.z));
    }

    /* ⚠️ THE WITNESS VOID (§5). Being seen by someone you are forbidden to
       kill is a problem you must solve by BREAKING CONTACT — you cannot solve
       it with the blade, because that is the other void. */
    if(seatSeen[0]){
      sim.unseenT = 0;
      sim.witnessT += dt;
      if(sim.witnessT > WITNESS_GRACE) sim.hunter.witnessed = true;
    } else {
      sim.unseenT += dt;
      if(sim.unseenT > WITNESS_BREAK){ sim.witnessT = 0; sim.hunter.witnessed = false; }
    }
    /* partner seats carry their own witness clocks (banked locally per client) */
    for(let i=1;i<sim.hunters.length;i++){
      const h=sim.hunters[i];
      if(seatSeen[i]){
        h.unseenT=0; h.witnessT=(h.witnessT||0)+dt;
        if(h.witnessT > WITNESS_GRACE) h.witnessed = true;
      } else {
        h.unseenT=(h.unseenT||0)+dt;
        if(h.unseenT > WITNESS_BREAK){ h.witnessT=0; h.witnessed=false; }
      }
    }
    return broke;
  };

  /* Striking a colonist. Armed ones are the best quarry in the game; the
     others are a void with a name attached. */
  sim.strikeColonist = function({target, dist, part='body', by=null}){
    const q = target, H = sim.hunter;
    if(!q || !q.alive) return {miss:true};
    const K = KINDS[q.kind], v = validityOf(q.kind);
    const striker = by || sim.player;
    q.alive = false;
    if(sim.colony) sim.colony.alarm = 20;     // the rest hear it happen

    const ctx = {
      tier:K.tier, specimenPct: K.valid ? 0.9 : 0.4,
      cloaked:striker.cloaked, everAware:q.alert>0.3,
      dist, reach:K.reach, engageRange:ENGAGE_RANGE, thrown:true,
      drewBlood:H.bleed>0, wasCharging:q.state==='CLOSING'||q.state==='FIRING',
      gaveGround:H.gaveGround, strikes:1,
      cycleObserved:true, inBeddingGround:false, doctrine:H.doctrine,
      integrity: part==='skull'?INTEGRITY.skull:INTEGRITY.clean,
      party:1, consecutive:0,
      fleeing: q.state==='FLEEING',
      weaponCap: weaponCap(H, H.primary||'spears'),
      witnessed: H.witnessed,
      /* the prohibition, expressed as the void it actually is */
      young:   v.voidAs==='young',
      noThreat:v.voidAs==='noThreat'
    };
    const rec = trophyScore(ctx);
    rec.bounty = 0;                            // nobody trades in people
    rec.species = K.label; rec.colonist = true; rec.kind = q.kind;
    rec.at = sim.simSec; rec.dist = dist; rec.part = part;
    if(!v.ok) rec.prohibition = K.note;
    H.trophies.push(rec);
    H.honor += rec.score;
    if(rec.voided) H.voids++;
    H.standing = standing(H.trophies);
    H.disgrace = disgrace(H.trophies);
    const f = fallOf(H.disgrace); H.fall=f.key; H.badBlood=!!f.hunted;
    rec.rank = rankOf(H.standing); rec.fall = f; rec.disgrace = H.disgrace;
    sim.lastReckoning = rec;
    return rec;
  };

  /* a census, so a soak can assert the food web is actually STABLE */
  sim.census = function(){
    /* keyed by ROLE as well as species: species keys differ on every world
       now, so any test or UI that wants to talk about "the apex" has to ask
       by role or it is only ever true of one seed */
    const c = {alive:{}, byRole:{}, dead:0, carrion:sim.carrion.length,
               fed:0, hunting:0};
    for(const f of sim.fauna){
      const sp = sim.species[f.species];
      if(f.alive && !f.gone){
        c.alive[f.species]=(c.alive[f.species]||0)+1;
        if(sp) c.byRole[sp.role]=(c.byRole[sp.role]||0)+1;
      } else c.dead++;
      c.fed += f.fed||0;
      if(f.state==='STALK') c.hunting++;
    }
    return c;
  };
  /* find this world's animal for a role — the world-agnostic way to ask */
  sim.byRole = role => sim.wgen.species.find(s=>s.role===role);
  sim.faunaByRole = role => sim.fauna.find(f=>{
    const sp=sim.species[f.species]; return sp && sp.role===role; });

  /* the specimen is rolled once, at world creation, and never re-rolled */
  sim.rollQuarry();
  sim.populate();
  sim.setupColony();          // ~1 world in 5 has people on it
  /* M13: on an Old Ground, the AUTHORED Named rides the apex — the great
     hunt is standing on the world the moment you land, name, marking,
     history and all. It is not rolled, and it starts wary of hunters:
     it has met your kind before. */
  if(wgen.named){
    const ap = sim.faunaByRole('apex');
    if(ap){ ap.specimenPct = NAMED_PCT; ap.named = {...wgen.named};
            ap.gravid = false; ap.wary = 1; }
  }

  /* fingerprint for determinism tests */
  sim.fingerprint = function(){
    const Q=sim.Q;
    const H=sim.hunter;
    const v = [Q.x,Q.z,Q.facing,Q.awareness,Q.spooks,sim.simSec,
               sim.wind.dir,sim.wind.strength,sim.tracks.length,
               Q.wary,Q.carrying?1:0,H.breaks,H.scarCredit,
               Object.keys(H.injuries).length,sim.player.x,sim.player.z,
               H.bleed,H.bleeds,Q.drewBlood?1:0,H.pendingLoss?1:0,
               H.honor,H.bounty,H.voids,H.trophies.length,
               Q.specimenPct,Q.strikes,Q.everAware?1:0];
    let h=5381;
    for(const n of v){ h=((h*33) ^ Math.round(n*10000)) >>> 0; }
    return h;
  };

  return sim;
}

/* rebuild a sim straight from a save file */
export function loadSim(json){
  const s=typeof json==='string'?JSON.parse(json):json;
  return createSim(s.seed, s.profileKey, s.ground||null).restoreState(s);
}
