/* ============================================================
   QUARRY — market.js   (M8, THE MARKET)

   Where bounty finally means something, and where the two currencies stop
   being an abstract table and start being a decision you make with a wallet.

   ⚠️ WEAPONS ARE COMMITMENTS, NOT STATS (§10). One primary plus your blades;
   swapping means going back to the ship. And the class you carry decides the
   CEILING of every kill you make with it:
     - blade / thrown  — Close Work and above. Cheap. Always the highest path.
     - snare / net     — honest mid-range. No cap, and it lets a wounded beast
                         REACH you, which is how you get to The Contest.
     - ranged energy   — reliable, silent, and it caps you at CULLING forever.
   ⚠️ Optics, calls, journal, ship range and medical are PURE IMPROVEMENT with
   no honor cost. That asymmetry is the arc of the first ten hours: learning
   that money belongs in the things that do not touch your score.

   Deterministic and headless. No THREE, no DOM.
   ============================================================ */

export const WEAPONS = {
  spears: { label:'THROWING SPEARS', cls:'thrown', cap:null, cost:0, owned:true,
    note:'Honest range. It can still reach you, and that is the point.' },
  blade:  { label:'WRIST BLADES', cls:'blade', cap:null, cost:0, owned:true,
    note:'Inside its reach or nothing. The highest-scoring thing you can carry.' },
  net:    { label:'WEIGHTED NET', cls:'snare', cap:null, cost:190,
    note:'Fouls it at mid-range and lets it come to you. The road to The Contest.' },
  lance:  { label:'PLASMA LANCE', cls:'energy', cap:'culling', cost:340,
    note:'Silent, certain, and it caps every kill you make with it at CULLING.' },
  burner: { label:'ARC BURNER', cls:'energy', cap:'culling', cost:520,
    note:'Kills anything at any range. Your standing will show it.' }
};
export const WEAPON_KEYS = Object.keys(WEAPONS);

/* ⚠️ EVERYTHING HERE IS HONOR-NEUTRAL ON PURPOSE. If any of it bought score,
   the two-currency conflict would collapse into "money is good, actually". */
export const GEAR = {
  optic2:   { label:'RANGING OPTICS', cost:150, once:true,
              note:'Read a specimen twice as far out.', apply:h=>h.opticRange=2.0 },
  journal:  { label:'FIELD JOURNAL BINDING', cost:130, once:true,
              note:'A world you have hunted keeps its need-zones.', apply:h=>h.journalPlus=true },
  tank:     { label:'EXTENDED TANK', cost:210, once:true,
              note:'+60 fuel capacity. More galaxy per carcass.', apply:h=>h.tankPlus=60 },
  medkit:   { label:'FIELD SURGERY', cost:90, once:false,
              note:'Close one injury now, instead of waiting days for it.' },
  quiver:   { label:'SPEAR QUIVER', cost:70, once:true,
              note:'Carry six instead of three.', apply:h=>h.spearMax=6 },
  calls:    { label:'CALL REEDS', cost:110, once:true,
              note:'Draw a beast in. Honorable — it never loses its chance to notice you.',
              apply:h=>h.calls=true }
};
export const GEAR_KEYS = Object.keys(GEAR);

/* ---------- MERCHANTS ARE PLACES, NOT MENUS ----------
   Drifting hulks, seedy and beautifully lit. Different merchants serve
   different clans, and some will not deal with a Bad Blood (M10 will make
   that bite; the refusal is already wired). */
export const MERCHANT_NAMES = [
  'THE LONG DEBT','SALT AND IRON','THE SECOND ANSWER','GRAVE OF NAMES',
  'THE PATIENT HULK','NINE QUIET DOORS','THE LAST HONEST SCALE','ASH MARKET'
];
export const MERCHANT_KEEPERS = [
  'a keeper who does not look up','a keeper with a clan brand burned out',
  'a keeper who counts in a language you do not have',
  'a keeper who knew your predecessor','a keeper who will not be hurried',
  'a keeper missing the same hand you nearly lost'
];

/* One system in a sector carries a merchant. Deterministic from the seed —
   a hulk you found once is still there when you come back. */
export function merchantFor(worldSeed){
  /* ⚠️ KEEP IT UNSIGNED THE WHOLE WAY. `h ^= h >>> 13` yields a SIGNED int32,
     and a negative h makes `h % 100` negative, which sails under every
     threshold test — measured 63% of systems carrying a merchant instead of
     34%. The trailing >>> 0 on each step is load-bearing. */
  let h = worldSeed >>> 0;
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 2246822507) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  if((h % 100) >= 34) return null;            // ~1 system in 3 has one
  const pick = (arr, salt) => arr[((h >>> salt) % arr.length)];
  const stockN = 3 + ((h >>> 7) % 3);
  const pool = [...WEAPON_KEYS.filter(k=>WEAPONS[k].cost>0), ...GEAR_KEYS];
  const stock = [];
  for(let i=0;i<stockN;i++){
    const k = pool[((h >>> (3+i*4)) + i*7) % pool.length];
    if(!stock.includes(k)) stock.push(k);
  }
  /* prices drift by hulk — the same lance is not the same price twice */
  const drift = 0.82 + ((h >>> 11) % 45)/100;
  return {
    name: pick(MERCHANT_NAMES, 2),
    keeper: pick(MERCHANT_KEEPERS, 5),
    stock, drift: Math.round(drift*100)/100,
    /* ⚠️ some will not deal with a Bad Blood — M10 sets the flag, this reads it */
    refusesBadBlood: (h % 3) === 0
  };
}
export const priceOf = (key, merchant) => {
  const item = WEAPONS[key] || GEAR[key];
  if(!item) return 0;
  return Math.max(1, Math.round(item.cost * (merchant ? merchant.drift : 1)));
};

/* ---------- buying ----------
   Pure function over the hunter: returns what changed, or why it could not. */
export function canBuy(hunter, key, merchant){
  const item = WEAPONS[key] || GEAR[key];
  if(!item) return { ok:false, why:'no such thing' };
  if(merchant && merchant.refusesBadBlood && hunter.badBlood)
    return { ok:false, why:'this keeper will not deal with a Bad Blood' };
  const price = priceOf(key, merchant);
  if((hunter.bounty||0) < price) return { ok:false, why:'not enough bounty', price };
  if(WEAPONS[key] && hunter.kit[key]) return { ok:false, why:'you carry one already', price };
  if(GEAR[key] && GEAR[key].once && hunter.gear && hunter.gear[key])
    return { ok:false, why:'you already have it', price };
  if(key==='medkit' && !Object.keys(hunter.injuries||{}).length)
    return { ok:false, why:'nothing to close', price };
  return { ok:true, price };
}

export function buy(hunter, key, merchant){
  const q = canBuy(hunter, key, merchant);
  if(!q.ok) return q;
  hunter.bounty -= q.price;
  hunter.gear = hunter.gear || {};
  if(WEAPONS[key]){
    hunter.kit[key] = true;
    return { ok:true, price:q.price, bought:key, kind:'weapon' };
  }
  if(key==='medkit'){
    /* §4: injuries heal with time AND BOUNTY. This is the bounty half. */
    const worst = Object.entries(hunter.injuries)
      .sort((a,b)=>b[1].sev-a[1].sev)[0];
    if(worst){
      if(worst[1].sev > 1) worst[1].sev--;
      else delete hunter.injuries[worst[0]];
    }
    return { ok:true, price:q.price, bought:key, kind:'medical', closed:worst && worst[0] };
  }
  hunter.gear[key] = true;
  if(GEAR[key].apply) GEAR[key].apply(hunter);
  return { ok:true, price:q.price, bought:key, kind:'gear' };
}

/* ⚠️ THE WEAPON YOU CARRY SETS THE CEILING. Read at strike time so that
   buying the silent, certain thing quietly costs you the top of the table —
   which is exactly the trade §10 wants you to feel. */
export function weaponCap(hunter, weaponKey){
  const w = WEAPONS[weaponKey];
  return w ? w.cap : null;
}
