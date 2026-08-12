/* ============================================================
   QUARRY — universe.js   (M6, THE UNIVERSE)

   The endless part. A ship, fuel, a star map, and worlds you can leave and
   come back to.

   ⚠️ YOU NEVER RENDER THE GALAXY. The star map is a 2D board — the Empire
   board's descendant: sectors, systems, routes, fuel, fog. You render exactly
   ONE hunting ground at a time, the same way exactly one map renders in Age
   of Toys. That single choice is what makes an endless universe browser-scale
   instead of impossible (§9).

   ⚠️ ONLY DELTAS PERSIST. A world is a SEED — its terrain, its Law, its whole
   biosphere regenerate identically from that seed every time. What gets saved
   is only what the seed cannot know: that you have been there, what you
   worked out, what you built, and what got away carrying your knife. A few
   hundred bytes per world, so nine or ten worlds becoming *yours* costs
   nothing.

   Deterministic and headless. No THREE, no DOM.
   ============================================================ */

export const SECTOR_SYSTEMS = 7;     // systems you can see from one sector
export const FUEL_MAX       = 100;
/* ⚠️ CALIBRATED AGAINST THE BOARD, not guessed. Systems sit on an ~80x76
   board, so the mean jump is ~40 units; at the first value (3.1) a typical
   jump cost 173 fuel against a 100 tank and NOTHING was ever reachable.
   0.7 puts a jump near 28 — a full tank is about three and a half jumps. */
export const FUEL_PER_UNIT  = 0.7;
/* ⚠️ THIS IS WHERE §6 BITES. A jump is ~84 bounty. A butchered kill pays ~97,
   so the dishonorable hunter refuels on one carcass; The Contest pays ~16, so
   the honorable one needs five. Playing for honor really does strand you, and
   that is the design, not a bug to tune away. */
export const REFUEL_COST    = 3;     // bounty per unit of fuel
export const JUMP_MIN       = 12;    // a jump always costs something
export const SECTOR_JUMP    = 62;    // crossing into the next sector

/* ---------- the galaxy is a hash, not a data structure ---------- */
export function hashSeed(...ints){
  let h = 2166136261 >>> 0;
  for(const n of ints){
    let v = (n|0) >>> 0;
    for(let i=0;i<4;i++){ h ^= (v & 255); h = Math.imul(h, 16777619) >>> 0; v >>>= 8; }
  }
  /* final avalanche — without it neighbouring coordinates stay correlated,
     which is the same trap makeRNG's warmup fixes */
  h ^= h >>> 15; h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13; h = Math.imul(h, 3266489909) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}
export const worldSeedFor = (galaxy, sx, sy, idx) => hashSeed(galaxy, sx, sy, idx, 0x51ed);

const SYS_A=['Arren','Bala','Corvid','Dross','Ekker','Fell','Gath','Hesp','Ilm','Joss',
             'Kest','Lune','Morrow','Nix','Orrel','Pell','Quill','Rask','Sarn','Tave',
             'Ulth','Vane','Wray','Yarrow','Zeph'];
const SYS_B=['I','II','III','IV','V','VI','VII','VIII','IX','X','Minor','Prime','Reach',
             'Deep','Verge','Rest','Hollow','Watch'];

/* ---------- a sector: SECTOR_SYSTEMS worlds laid out on a small board ---------- */
export function generateSector(galaxy, sx, sy){
  const rng = mulberry(hashSeed(galaxy, sx, sy, 0x5ec7));
  const systems = [];
  for(let i=0;i<SECTOR_SYSTEMS;i++){
    /* spread them so no two sit on top of each other on the board */
    let x, y, tries=0;
    do{
      x = 10 + rng()*80; y = 12 + rng()*76; tries++;
    } while(tries<40 && systems.some(s=>Math.hypot(s.x-x,s.y-y) < 19));
    systems.push({
      idx:i, sx, sy,
      seed: worldSeedFor(galaxy, sx, sy, i),
      name: SYS_A[Math.floor(rng()*SYS_A.length)] + ' ' +
            SYS_B[Math.floor(rng()*SYS_B.length)],
      x, y
    });
  }
  return systems;
}

/* small deterministic rng — universe generation must not touch the sim's */
function mulberry(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const jumpCost = (a, b) =>
  Math.max(JUMP_MIN, Math.round(Math.hypot(a.x-b.x, a.y-b.y) * FUEL_PER_UNIT));

/* ============================================================
   THE UNIVERSE — the thing that persists
   ============================================================ */
export const SAVE_VERSION = 1;

export function createUniverse(galaxySeed = 20260811){
  const u = {
    v: SAVE_VERSION,
    galaxy: galaxySeed,
    at: { sx:0, sy:0, idx:0 },        // where the ship is
    fuel: FUEL_MAX,
    /* the ledger travels with you — this is the hunter, not the world */
    hunter: null,
    /* ⚠️ ONLY DELTAS. keyed by world seed. */
    journal: {},
    jumps: 0
  };

  u.sector = () => generateSector(u.galaxy, u.at.sx, u.at.sy);
  u.here   = () => u.sector().find(s=>s.idx===u.at.idx);
  u.worldSeed = () => worldSeedFor(u.galaxy, u.at.sx, u.at.sy, u.at.idx);

  /* what we know about a world, if anything */
  u.entry = seed => u.journal[seed] || null;
  u.known = seed => !!u.journal[seed];

  /* Write down what this visit taught us. Called on arrival and on leaving —
     everything here is a DELTA the seed could not have told us. */
  u.record = function(seed, patch){
    const e = u.journal[seed] || {
      seed, visits:0, firstSeen:null, law:null, biome:null,
      species:[], zones:null, kills:0, honor:0, bounty:0,
      nemesis:null,           // what got away, and what it is wearing
      structures:[],          // blinds, caches — you improve a world by hunting it
      at:null                 // WHERE it is, or you can never go back
    };
    /* ⚠️ STAMP THE COORDINATES. Without this the journal knows everything
       about a world except how to reach it, and "nine or ten worlds become
       yours" (§9) quietly becomes "you will never see that world again". */
    if(!e.at && seed === u.worldSeed()) e.at = { ...u.at };
    Object.assign(e, patch);
    u.journal[seed] = e;
    return e;
  };

  /* YOUR CHARTS. A world you have been to can be plotted back to — that is
     what makes it yours rather than one of infinitely many. */
  u.courseTo = function(seed){
    const e = u.journal[seed];
    if(!e || !e.at) return null;
    const sectors = Math.abs(e.at.sx-u.at.sx) + Math.abs(e.at.sy-u.at.sy);
    let local = 0;
    if(sectors === 0){
      const sys = u.sector().find(s=>s.idx===e.at.idx);
      local = sys ? jumpCost(u.here(), sys) : 0;
      if(e.at.idx === u.at.idx) local = 0;
    }
    return { sectors, fuel: sectors*SECTOR_JUMP + local, at:{...e.at}, entry:e };
  };
  u.jumpTo = function(seed){
    const c = u.courseTo(seed);
    if(!c) return { ok:false, reason:'not on your charts' };
    if(c.fuel > u.fuel) return { ok:false, reason:'not enough fuel', cost:c.fuel };
    u.fuel -= c.fuel;
    if(c.sectors || c.at.idx !== u.at.idx) u.jumps++;
    u.at = { ...c.at };
    return { ok:true, cost:c.fuel, seed:u.worldSeed() };
  };

  /* ---------- travel ---------- */
  u.canReach = function(sys){
    const cost = jumpCost(u.here(), sys);
    return { cost, ok: sys.idx !== u.at.idx && cost <= u.fuel };
  };
  u.travel = function(sys){
    const r = u.canReach(sys);
    if(!r.ok) return { ok:false, reason: sys.idx===u.at.idx ? 'already here'
                                                            : 'not enough fuel', cost:r.cost };
    u.fuel -= r.cost; u.at = { sx:sys.sx, sy:sys.sy, idx:sys.idx }; u.jumps++;
    return { ok:true, cost:r.cost, seed:u.worldSeed() };
  };
  /* ⚠️ WITHOUT THIS THE GALAXY IS 7 WORLDS. In-sector travel alone caps you at
     SECTOR_SYSTEMS, however many times you jump — the universe is only endless
     because sx/sy are unbounded integers and you can cross into the next
     sector. Costs more than a local hop, because that is the shape of the
     decision: hunt this neighbourhood out, or pay to see somewhere new. */
  u.neighbours = () => ([
    { dx: 0, dy:-1, label:'CORE-WARD' }, { dx: 1, dy: 0, label:'SPINWARD' },
    { dx: 0, dy: 1, label:'RIM-WARD' },  { dx:-1, dy: 0, label:'TRAILING' }
  ].map(n => ({ ...n, sx:u.at.sx+n.dx, sy:u.at.sy+n.dy, cost:SECTOR_JUMP })));

  u.crossTo = function(n){
    if(u.fuel < SECTOR_JUMP) return { ok:false, reason:'not enough fuel', cost:SECTOR_JUMP };
    u.fuel -= SECTOR_JUMP;
    u.at = { sx:n.sx, sy:n.sy, idx:0 };
    u.jumps++;
    return { ok:true, cost:SECTOR_JUMP, seed:u.worldSeed() };
  };

  /* fuel is bought with BOUNTY — which is the whole reason the carcass is
     worth anything, and the reason a run of honorable kills leaves you stranded */
  u.refuel = function(units){
    const want = Math.min(units, FUEL_MAX - u.fuel);
    const afford = Math.floor((u.hunter?.bounty ?? 0) / REFUEL_COST);
    const got = Math.max(0, Math.min(want, afford));
    u.fuel += got;
    if(u.hunter) u.hunter.bounty -= got * REFUEL_COST;
    return { got, spent: got*REFUEL_COST };
  };

  /* ---------- persistence ---------- */
  /* ⚠️ PACK AT SAVE TIME, not at commit time. `u.hunter` is allowed to be the
     LIVE hunter object, which is what makes refuel() actually able to spend
     your bounty — the first version spent from a stale snapshot that the next
     commit overwrote, so fuel was free and the whole §6 tension evaporated.
     packHunter is idempotent, so packing an already-packed hunter is safe. */
  u.save = () => JSON.stringify({
    v:u.v, galaxy:u.galaxy, at:{...u.at}, fuel:u.fuel, jumps:u.jumps,
    hunter: u.hunter ? packHunter(u.hunter) : null, journal:u.journal
  });
  u.load = function(json){
    const s = typeof json==='string' ? JSON.parse(json) : json;
    if(!s || s.v !== SAVE_VERSION) return false;
    u.galaxy=s.galaxy; u.at={...s.at}; u.fuel=s.fuel; u.jumps=s.jumps||0;
    u.hunter=s.hunter||null; u.journal=s.journal||{};
    return true;
  };
  return u;
}

export function loadUniverse(json, fallbackGalaxy=20260811){
  const u = createUniverse(fallbackGalaxy);
  try{ if(json && u.load(json)) return u; }catch(e){}
  return u;
}

/* ---------- what the hunter carries between worlds ----------
   NOT the world, NOT the quarry — the person. Kit, injuries, the ledger and
   the trophy shelf. Everything else regenerates from a seed. */
export function packHunter(hunter){
  return {
    kit:{...hunter.kit},
    injuries: JSON.parse(JSON.stringify(hunter.injuries)),
    bleed:hunter.bleed, bleeds:hunter.bleeds,
    breaks:hunter.breaks, scars:hunter.scars, scarCredit:hunter.scarCredit,
    honor:hunter.honor, bounty:hunter.bounty, voids:hunter.voids,
    standing:hunter.standing||0, everHadCloak:!!hunter.everHadCloak,
    primary:hunter.primary||'spears', gear:{...(hunter.gear||{})},
    badBlood:!!hunter.badBlood,
    doctrine:hunter.doctrine, taken:[...hunter.taken],
    trophies: JSON.parse(JSON.stringify(hunter.trophies)),
    lastApproach:{...hunter.lastApproach}, approachRun:{...hunter.approachRun},
    pendingLoss: hunter.pendingLoss ? {options:[...hunter.pendingLoss.options]} : null
  };
}
export function unpackHunter(hunter, packed){
  if(!packed) return hunter;
  Object.assign(hunter, {
    kit:{...packed.kit},
    injuries: JSON.parse(JSON.stringify(packed.injuries||{})),
    bleed:packed.bleed||0, bleeds:packed.bleeds||0,
    breaks:packed.breaks||0, scars:packed.scars||0, scarCredit:packed.scarCredit||0,
    honor:packed.honor||0, bounty:packed.bounty||0, voids:packed.voids||0,
    standing:packed.standing||0, everHadCloak:!!packed.everHadCloak,
    primary:packed.primary||'spears', gear:{...(packed.gear||{})},
    badBlood:!!packed.badBlood,
    doctrine:packed.doctrine||'vokaar', taken:[...(packed.taken||[])],
    trophies: JSON.parse(JSON.stringify(packed.trophies||[])),
    lastApproach:{...(packed.lastApproach||{})},
    approachRun:{...(packed.approachRun||{})},
    pendingLoss: packed.pendingLoss ? {options:[...packed.pendingLoss.options]} : null
  });
  return hunter;
}
