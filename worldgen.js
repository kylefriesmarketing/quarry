/* ============================================================
   QUARRY — worldgen.js   (M4, THE LAW)

   Every world is generated under a SINGLE BIOLOGICAL LAW that every organism
   on it obeys. That one rule is what makes a procedural world coherent,
   memorable and worth returning to — Barlowe's answer to the parts-bin
   critique ("quadruped that walks like a deer… with a tiny head… plus
   tentacles", and they all bleed together).

   ⚠️ THE LAW IS ECOLOGICAL OR MORPHOLOGICAL, NOT A SENSORY DELETION.
   Sight, sound and scent are UNIVERSAL — every world has all three; what
   varies is which creature weights which. A law that removes a sense removes
   most of the design space with it. Total-sensory laws exist only as a
   LEGENDARY world type (`legendary:true`), roughly as often as a Named beast.

   Deterministic and headless: no THREE, no DOM, seeded rng in, world out.
   ============================================================ */

/* ---------- THE LAWS ----------
   `effect` is READ BY THE SIM. A law that does not change how the world is
   hunted is decoration, and decoration is exactly what this system exists to
   avoid. Every field below is consumed somewhere. */
export const LAWS = {
  colonial: {
    label:'EVERYTHING HERE IS COLONIAL',
    clause:'nothing is ever only one animal',
    line:'No creature here is one animal.',
    hunt:'Killing it means killing enough of it.',
    effect:{ bodies:3, hpSpread:true } },
  airborne: {
    label:'NOTHING HERE TOUCHES THE GROUND',
    clause:'nothing has ever touched the ground',
    line:'Buoyant, gliding, anchored. Nothing walks.',
    hunt:'Footing is irrelevant. Your silhouette against the sky is everything.',
    effect:{ hover:true, coverMul:0.25, substrateMul:0.1 } },
  lifecycle: {
    label:'EVERYTHING IS A LIFECYCLE STAGE OF ONE ORGANISM',
    clause:'the herd you shadowed this morning is a different creature by evening',
    line:'The herd you shadowed this morning is a different creature by evening.',
    hunt:'What you tracked at dawn is not what you find at dusk.',
    effect:{ morph:true } },
  lithic: {
    label:'EVERYTHING HERE IS ARMOURED IN LOCAL MINERAL',
    clause:'everything wears the ground it eats',
    line:'Rock-eaters, wearing the ground they came from.',
    hunt:'Weak points are structural, not anatomical. Blades over energy.',
    effect:{ armour:0.55, bladeOnly:true } },
  host: {
    label:'EVERYTHING HERE IS BOUND TO A HOST',
    clause:'nothing is ever alone',
    line:'Nothing on this rock is solitary.',
    hunt:'Every kill is two kills, or one and an angry survivor.',
    effect:{ paired:true } },
  heliotropic: {
    label:'EVERYTHING GROWS TOWARD THE HEAT SOURCE',
    clause:'the whole biosphere leans toward the heat',
    line:'The whole biosphere leans one way.',
    hunt:'Shade is where nothing lives. Hunt the lit side or hunt nothing.',
    effect:{ lean:true, shadeEmpty:true } },
  migratory: {
    label:'EVERYTHING MIGRATES ON ONE CLOCK',
    clause:'the board empties and refills all at once',
    line:'The board empties and refills together.',
    hunt:'Miss the window and the world is bare for days.',
    effect:{ migrate:true } },
  cold: {
    /* ⚠️ a TOOL law, not a sense law — it blinds YOUR optic, not their eyes */
    label:'NOTHING HERE IS WARM',
    clause:'nothing runs a temperature',
    line:'Nothing on this world runs a temperature.',
    hunt:'Your thermal optic is dead weight here.',
    effect:{ thermalBlind:true } },
  eyeless: {
    label:'NOTHING HERE HAS EYES',
    clause:'nothing has ever needed to see',
    line:'No creature here has ever needed to see.',
    hunt:'Stillness buys you nothing. Wind and silence are all you have.',
    legendary:true,
    effect:{ noSight:true } }
};
export const LAW_KEYS = Object.keys(LAWS).filter(k=>!LAWS[k].legendary);
export const LEGENDARY_LAW_KEYS = Object.keys(LAWS).filter(k=>LAWS[k].legendary);
export const LEGENDARY_LAW_CHANCE = 0.06;

/* ---------- BIOMES — materials, palette, sky, locomotion constraint ---------- */
export const BIOMES = {
  saltflat:  { label:'SALT FLATS',    ground:0xd8d2c0, sky:'day',  cover:0.35,
               noun:'a cracked white pan under a hard sun' },
  ashforest: { label:'ASH FOREST',    ground:0x6b6560, sky:'dusk', cover:0.95,
               noun:'a grey forest that has already burned' },
  tidal:     { label:'TIDAL SHELF',   ground:0x7a8a86, sky:'gold', cover:0.55,
               noun:'a shelf the water leaves twice a day' },
  glass:     { label:'GLASS DESERT',  ground:0xa9b4c4, sky:'day',  cover:0.20,
               noun:'a desert of fused glass that rings underfoot' },
  fungal:    { label:'FUNGAL BASIN',  ground:0x8a7a5e, sky:'dusk', cover:1.00,
               noun:'a warm basin choked with something that is not plants' },
  rift:      { label:'RIFT CANYON',   ground:0x8a6a58, sky:'gold', cover:0.60,
               noun:'a red canyon cut deeper than light reaches' },
  moss:      { label:'MOSS PLAIN',    ground:0x6f7a52, sky:'day',  cover:0.85,
               noun:'a soft green plain that swallows every sound' }
};
export const BIOME_KEYS = Object.keys(BIOMES);

/* ---------- ROLE × MECHANISM × LOCOMOTION ----------
   Role decides behaviour, need zones, threat and where it lives.
   Mechanism is the STRANGE BIOLOGY.
   Locomotion is rolled SEPARATELY, because that is what makes the silhouette
   vary independently of what the animal does for a living. */
export const ROLES = {
  grazer:   { tier:'common',    threat:0.45, reach:3.6, speed:2.1, eats:null,
              pop:5, profile:['watcher','balanced'] },
  filter:   { tier:'common',    threat:0.10, reach:2.2, speed:1.3, eats:null,
              pop:4, profile:['listener','nose'] },
  migrant:  { tier:'uncommon',  threat:0.30, reach:2.8, speed:2.6, eats:null,
              pop:4, profile:['watcher','listener'] },
  scavenger:{ tier:'uncommon',  threat:0.55, reach:3.0, speed:1.9, eats:'carrion',
              pop:2, profile:['nose','balanced'] },
  broodhost:{ tier:'uncommon',  threat:0.40, reach:2.6, speed:1.1, eats:null,
              pop:2, profile:['nose','listener'] },
  ambush:   { tier:'epic',      threat:0.90, reach:4.4, speed:1.5, eats:'meat',
              pop:1, profile:['ambusher'] },
  pursuit:  { tier:'epic',      threat:0.85, reach:4.0, speed:2.8, eats:'meat',
              pop:1, profile:['balanced','listener'] },
  apex:     { tier:'legendary', threat:1.00, reach:5.2, speed:3.0, eats:'meat',
              pop:1, profile:['balanced','ambusher','blindhunter'] }
};
export const ROLE_KEYS = Object.keys(ROLES);

export const MECHANISMS = {
  colonial:  'a colony wearing one shape',
  puppeteer: 'something else is steering it',
  compressed:'it will be three things before it dies',
  chemical:  'it fights with chemistry, not teeth',
  lithic:    'it eats the ground and wears it',
  buoyant:   'it holds itself up with gas',
  mimetic:   'it is pretending to be the terrain',
  symbiont:  'it is carrying passengers',
  echoic:    'it reads the world by shouting at it',
  phototropic:'it grows toward the light and cannot stop'
};
export const MECH_KEYS = Object.keys(MECHANISMS);

/* ⚠️ Per Barlowe, some reference frames are deliberately NON-ANIMAL — the
   Skewer came from aircraft, the Sea Strider from ships. A parts bin of
   animals cannot exceed the sum of its animals. */
export const LOCOMOTION = {
  stilt:    { label:'stilt-walker',    legs:4, legLen:2.2, bodyH:2.6, bodyL:1.5, bodyW:0.95, ref:'animal' },
  undulate: { label:'undulator',       legs:0, legLen:0.0, bodyH:0.7, bodyL:3.2, bodyW:0.6,  ref:'animal' },
  roller:   { label:'roller',          legs:0, legLen:0.0, bodyH:1.1, bodyL:1.1, bodyW:1.1,  ref:'vehicle' },
  brachiate:{ label:'brachiator',      legs:2, legLen:2.6, bodyH:1.9, bodyL:1.0, bodyW:0.8,  ref:'animal' },
  drifter:  { label:'drifter',         legs:0, legLen:0.0, bodyH:3.4, bodyL:1.6, bodyW:1.6,  ref:'weather' },
  burrower: { label:'burrower',        legs:6, legLen:0.5, bodyH:0.6, bodyL:2.0, bodyW:1.0,  ref:'animal' },
  skimmer:  { label:'skimmer',         legs:0, legLen:0.0, bodyH:1.0, bodyL:2.8, bodyW:2.2,  ref:'ship' },
  anchor:   { label:'anchor-quadruped',legs:4, legLen:1.0, bodyH:1.3, bodyL:1.8, bodyW:1.6,  ref:'architecture' },
  multipede:{ label:'multipede',       legs:8, legLen:0.7, bodyH:0.9, bodyL:3.0, bodyW:0.7,  ref:'animal' }
};
export const LOCO_KEYS = Object.keys(LOCOMOTION);

/* ---------- NAMES ---------- */
const SYL_A = ['kar','vel','oss','thu','mor','gan','sil','dre','hab','nul','pyr','esk',
               'tor','wen','zha','lom','irn','ques','vad','shen'];
const SYL_MID= ['a','o','en','ir','ua','ys','ae','ol','un','er','ai','yth'];
const SYL_B = ['ith','ara','oun','esh','ul','oma','iss','ade','orn','ela','ux','ammon',
               'ir','oth','een','usk','al','ynth'];
function pick(rng, arr){ return arr[Math.floor(rng()*arr.length)]; }

/* ⚠️ THE NAME SPACE WAS 360 (20 x 18) AND THAT IS NOT ENOUGH. Measured across
   4000 seeds: every possible name appeared, and 4.5% of worlds shipped TWO
   SPECIES WITH THE SAME NAME. An optional middle syllable takes it to ~4,700,
   and generateWorld dedupes within a world on top — a world where two animals
   share a name is not a world anyone remembers. */
export function speciesName(rng){
  const mid = rng() < 0.45 ? pick(rng,SYL_MID) : '';
  const n = pick(rng,SYL_A)+mid+pick(rng,SYL_B);
  return n.charAt(0).toUpperCase()+n.slice(1);
}

/* ---------- THE NAMED ----------
   §8: procedurally named AND HISTORIED, Caves-of-Qud style — a name, a
   marking, and a short generated history. One per world at most; most worlds
   have none. A Named beast the game cannot describe is just a big health bar. */
const EPITHET = ['the Long','the Pale','the Quiet','the Deep','the Nine','the Hollow',
                 'the Slow','the Late','the Grey','the Patient','the Wide','the Last',
                 'the Unfed','the Twice-Struck','the Old Wound','the Untaken'];
const MARKING = ['a bone-white streak down one flank','a shattered crest, healed crooked',
                 'one limb shorter than the others','a hide gone grey with age',
                 'a ring of old scar where something held it','no marking at all, and that is worse',
                 'a stump where a trophy organ should be','burn-scarring across the back'];
const DEED    = ['took a hunter\'s arm','broke a blind and everything in it',
                 'walked out of a ring of fire','killed something it did not eat',
                 'has been tracked four times and taken none',
                 'drove an apex off its own kill','outlived the clan that named it',
                 'was left for dead and was not'];
const WHEN    = ['two seasons past','a long time ago','last winter','before the charts',
                 'twice, years apart','within living memory'];
export function nameTheNamed(rng, biomeKey){
  const b = BIOMES[biomeKey];
  return {
    name: speciesName(rng),
    epithet: pick(rng, EPITHET),
    marking: pick(rng, MARKING),
    history: `${pick(rng,DEED)} at ${b.label.toLowerCase()}, ${pick(rng,WHEN)}.`
  };
}

/* ---------- THE SILHOUETTE ----------
   §8's acceptance test: identify the creature from its OUTLINE, in thermal,
   at 150m. If you cannot, the generator rejects it and rolls again.

   ⚠️ That test has to run in the GENERATOR, headless, or it is not a test —
   it is a hope. So it operates on the body plan: a coarse width-by-height
   profile, which is exactly what an outline at 150m in thermal reduces to.
   Two creatures whose profiles are within SIL_MIN_DIST of each other read as
   the same animal at range, and the generator will not ship both. */
export const SIL_BANDS = 6;
export const SIL_MIN_DIST = 0.34;

export function silhouette(plan){
  /* width of the animal at six heights from ground to crown, normalised */
  const L = LOCOMOTION[plan.loco];
  const total = L.legLen*plan.scale + L.bodyH*plan.scale;
  const bands = [];
  for(let i=0;i<SIL_BANDS;i++){
    const y = (i+0.5)/SIL_BANDS * total;
    const legTop = L.legLen*plan.scale;
    let w;
    if(y < legTop) w = L.legs ? 0.10*L.legs*0.25*plan.scale : 0.02;
    else {
      /* body: an ellipse between legTop and total */
      const t = (y-legTop) / Math.max(0.001,(total-legTop));
      w = Math.sin(Math.PI*Math.min(1,Math.max(0,t))) * L.bodyW * plan.scale
          * (plan.neckLong ? 0.8 : 1);
    }
    bands.push(w);
  }
  const peak = Math.max(...bands, 0.001);
  return { bands: bands.map(b=>b/peak), height: total,
           aspect: (L.bodyL*plan.scale) / total };
}

export function silDistance(a,b){
  let d = 0;
  for(let i=0;i<SIL_BANDS;i++) d += Math.abs(a.bands[i]-b.bands[i]);
  d /= SIL_BANDS;
  /* height and aspect are read instantly at range — weight them heavily */
  d += Math.abs(Math.log(a.height/b.height)) * 0.55;
  d += Math.abs(Math.log(a.aspect/b.aspect)) * 0.35;
  return d;
}

/* ---------- PROCEDURAL VOICE ----------
   Every species' call synthesised from its own seed: formant, pitch envelope,
   rhythm and roughness derived from MASS and MECHANISM. Ten thousand species
   that each sound like themselves, at zero asset cost. The sim only produces
   the parameters; sfx in the view turns them into sound. */
export function voiceOf(rng, plan, role){
  const mass = plan.scale * LOCOMOTION[plan.loco].bodyL;
  const base = 380 / Math.pow(mass, 0.78);                 // big things are low
  return {
    f0: Math.max(42, Math.min(900, base*(0.8+rng()*0.5))),
    sweep: (rng()*2-1) * 0.55,                             // rising or falling
    rough: plan.mech==='chemical' ? 0.15 : (0.2+rng()*0.7),
    pulses: 1 + Math.floor(rng()*(plan.mech==='echoic'?6:3)),
    gap: 0.06+rng()*0.22,
    dur: 0.22 + rng()*(ROLES[role].eats==='meat' ? 0.9 : 0.45),
    formant: 1 + rng()*2.2
  };
}

/* ---------- SPECIES ---------- */
function makePlan(rng, law, biome){
  let loco = pick(rng, LOCO_KEYS);
  /* the LAW constrains the body plan — this is the whole point of a law */
  if(law.effect.hover) loco = pick(rng, ['drifter','skimmer','brachiate']);
  if(law.effect.armour!==undefined && rng()<0.6) loco = pick(rng, ['anchor','burrower','roller']);
  return {
    loco,
    scale: 0.62 + rng()*1.5,
    neckLong: rng() < 0.45,
    mech: law.effect.hover ? pick(rng,['buoyant','mimetic','symbiont'])
        : law.effect.armour!==undefined ? 'lithic'
        : law.effect.bodies ? 'colonial'
        : law.effect.morph ? 'compressed'
        : law.effect.paired ? 'symbiont'
        : law.effect.lean ? 'phototropic'
        : pick(rng, MECH_KEYS)
  };
}

export function generateSpecies(rng, lawKey, biomeKey, roleKey, existing){
  const law = LAWS[lawKey], R = ROLES[roleKey];
  let plan=null, sil=null, tries=0, rejected=0;
  /* ⚠️ THE GENERATOR REJECTS ITS OWN OUTPUT. Without this the roster is a
     parts bin and everything blurs together at range, which is the exact
     failure this milestone exists to prevent. */
  while(tries++ < 40){
    const p = makePlan(rng, law, biomeKey);
    const s = silhouette(p);
    const clash = existing.some(e => silDistance(s, e.sil) < SIL_MIN_DIST);
    if(!clash){ plan=p; sil=s; break; }
    rejected++;
  }
  if(!plan){ plan = makePlan(rng, law, biomeKey); sil = silhouette(plan); }

  const profile = pick(rng, R.profile);
  return {
    key: null,                          // assigned by generateWorld
    label: speciesName(rng).toUpperCase(),
    role: roleKey, tier: R.tier, profile,
    loco: plan.loco, mech: plan.mech, scale: plan.scale, neckLong: plan.neckLong,
    reach: R.reach * (0.75+plan.scale*0.35),
    threat: R.threat, speed: R.speed * (law.effect.hover?1.25:1),
    flee: R.speed * 3.2,
    eats: R.eats,
    gravidChance: 0.05 + rng()*0.18,
    namedChance: R.tier==='legendary' ? 0.10 : R.tier==='epic' ? 0.07 : 0.03,
    sil, rejected,
    voice: voiceOf(rng, plan, roleKey),
    /* the law, expressed on this animal */
    bodies: law.effect.bodies || 1,
    armour: law.effect.armour || 0,
    hover: !!law.effect.hover
  };
}

/* ---------- THE WORLD ---------- */
/* ⚠️ `line` is a sentence for the gate; `clause` is what survives being
   dropped after "where". Using `line` here produced "…where rock-eaters,
   wearing the ground they came from — and the biggest thing…", which is not
   a sentence. The acceptance test is that a STRANGER can read it. */
export function describeWorld(w){
  const b = BIOMES[w.biome], l = LAWS[w.law];
  const big = w.species.find(s=>s.role==='apex') || w.species[w.species.length-1];
  return `${b.noun}, where ${l.clause}, `
       + `and the biggest thing on it is ${aOrAn(LOCOMOTION[big.loco].label)}.`;
}
function aOrAn(s){ return (/^[aeiou]/i.test(s)?'an ':'a ')+s; }

export function generateWorld(seed, rng){
  const legendary = rng() < LEGENDARY_LAW_CHANCE;
  const law   = legendary ? pick(rng, LEGENDARY_LAW_KEYS) : pick(rng, LAW_KEYS);
  const biome = pick(rng, BIOME_KEYS);

  /* ⚠️ THE TROPHIC PYRAMID IS NOT OPTIONAL. Every world needs a base of
     grazers/filters, something in the middle, and at most one apex — tier
     rarity is a POPULATION consequence, not a loot table. */
  const roster = ['grazer','filter', pick(rng,['migrant','broodhost']),
                  'scavenger', pick(rng,['ambush','pursuit']), 'apex'];

  const species = [];
  for(const role of roster){
    const s = generateSpecies(rng, law, biome, role, species);
    s.key = role + '_' + species.length;
    /* ⚠️ no two animals on one world share a name (measured: 4.5% of worlds
       did, before this) */
    let guard=0;
    while(species.some(e=>e.label===s.label) && guard++<30) s.label = speciesName(rng).toUpperCase();
    species.push(s);
  }

  const w = { seed, law, biome, legendary, species,
              population: {} , rejected: species.reduce((a,s)=>a+s.rejected,0) };
  for(const s of species) w.population[s.key] = ROLES[s.role].pop;
  w.description = describeWorld(w);
  return w;
}

/* Worst-case pairwise silhouette distance in a world — the number the
   acceptance test actually asserts on. */
export function silhouetteAudit(w){
  let worst = Infinity, pair = null;
  for(let i=0;i<w.species.length;i++)
    for(let j=i+1;j<w.species.length;j++){
      const d = silDistance(w.species[i].sil, w.species[j].sil);
      if(d < worst){ worst = d; pair = [w.species[i].label, w.species[j].label]; }
    }
  return { worst, pair, pass: worst >= SIL_MIN_DIST };
}
