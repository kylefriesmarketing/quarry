/* ============================================================
   QUARRY — worthy.js   (M11, THE WORTHY)

   Armed colonists: the most honorable quarry in the code, and the most
   dangerous. They shoot back, they take cover, they COORDINATE, and once
   they know what is out here they hunt you (§11).

   ⚠️ THIS IS WHERE THE PROHIBITIONS BITE HARDEST. The unarmed, the young and
   the gravid are absolutely off the table — not "worth less", VOID. A hunter
   who cannot tell an armed colonist from a child at 80m has no business
   taking either, which is exactly why assessment through the optics exists.

   ⚠️ AND CLOAK DISCIPLINE CHANGES MEANING HERE. Against a beast the cloak
   costs you score. Against a settlement it stops being about score at all and
   becomes about NOT BEING WITNESSED — §5's void, "being witnessed by the
   unworthy and failing to correct it." Correcting it means breaking contact.
   You cannot correct it by killing them; that is the other void.

   Deterministic and headless. No THREE, no DOM.
   ============================================================ */

export const KINDS = {
  armed:   { key:'armed',   label:'AN ARMED COLONIST', tier:'epic',
             valid:true,  threat:0.75, reach:2.6, speed:2.4, sight:64,
             note:'It shoots back. That is what makes it worth taking.' },
  unarmed: { key:'unarmed', label:'A COLONIST',        tier:'common',
             valid:false, voidAs:'noThreat', threat:0.0, reach:1.4, speed:2.8,
             sight:52, note:'It could not have harmed you. That is not a hunt.' },
  young:   { key:'young',   label:'A CHILD',           tier:'common',
             valid:false, voidAs:'young', threat:0.0, reach:1.0, speed:3.1,
             sight:44, note:'Strictly forbidden. There is no reading of the code that allows it.' }
};

/* Roughly one world in five carries a settlement. Deterministic from the
   world seed, so a colony you found is there when you come back. */
export function colonyFor(worldSeed){
  let h = worldSeed >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 2654435761) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;          // ⚠️ unsigned the whole way (see market.js)
  if((h % 100) >= 22) return null;

  const rng = mul(h ^ 0x9e37);
  const n = 5 + Math.floor(rng()*5);
  const roster = [];
  /* every settlement has people who cannot fight in it. That is the point. */
  for(let i=0;i<n;i++){
    const r = rng();
    roster.push(r < 0.45 ? 'armed' : r < 0.80 ? 'unarmed' : 'young');
  }
  if(!roster.includes('armed')) roster[0]='armed';
  if(!roster.includes('unarmed')) roster[1]='unarmed';
  return { roster, spread: 16 + rng()*14, name: nameColony(rng) };
}
function mul(a){ return function(){ a|=0; a=(a+0x6D2B79F5)|0;
  let t=Math.imul(a^(a>>>15),1|a); t=(t+Math.imul(t^(t>>>7),61|t))^t;
  return ((t^(t>>>14))>>>0)/4294967296; }; }
const C_A=['Fallow','Ridge','Salt','Long','Ash','Quiet','Second','Cold','Low'];
const C_B=['Station','Holding','Camp','Works','Landing','Claim','Rest','Dig'];
function nameColony(rng){
  return C_A[Math.floor(rng()*C_A.length)]+' '+C_B[Math.floor(rng()*C_B.length)];
}

/* ---------- how a settlement reacts ----------
   COORDINATION is the thing that makes them dangerous: one who sees you tells
   the others, and armed ones converge while the rest run. */
export const ALARM_RADIUS   = 46;   // how far the word spreads
export const ENGAGE_RANGE   = 30;   // armed colonists open fire inside this
export const SHOOT_CD       = 1.9;
export const WITNESS_GRACE  = 6.0;  // seconds of being seen before it is a void
export const WITNESS_BREAK  = 3.0;  // seconds out of sight that clears it

/* Can this person see you right now? The cloak defeats it outright — which is
   the whole reason cloak discipline matters here. */
export function seenBy(p, player, dist, hasLOS){
  if(player.cloaked) return false;
  const K = KINDS[p.kind];
  if(dist > K.sight) return false;
  if(!hasLOS) return false;
  let ang = Math.atan2(player.x-p.x, player.z-p.z) - p.facing;
  while(ang>Math.PI) ang-=Math.PI*2; while(ang<-Math.PI) ang+=Math.PI*2;
  /* they have a front. Behind them you are unseen even in the open. */
  return Math.abs(ang) < 1.5;
}

/* ⚠️ VALIDITY IS NOT A MODIFIER. An unarmed colonist or a child is a VOID,
   full stop, and the void reason names which prohibition you broke. */
export function validityOf(kind){
  const K = KINDS[kind];
  return K.valid ? { ok:true } : { ok:false, voidAs:K.voidAs, note:K.note };
}
