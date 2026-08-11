/* ============================================================
   QUARRY — sfx.js   (M4, procedural voices + positional audio)

   Every species' call is SYNTHESISED FROM ITS OWN SEED — formant, pitch
   envelope, rhythm and roughness derived from mass and mechanism. Ten
   thousand species that each sound like themselves, at zero asset cost.

   ⚠️ POSITIONAL ACCURACY IS A CORRECTNESS REQUIREMENT, NOT POLISH (§2).
   COTW shipped broken directional audio for years — a bear at 100m sounding
   one metre away — in a game where hearing is a core channel. So panning and
   attenuation get a test harness (`probe()`), not a vibe check.

   PURE VIEW. The sim decides what happens; this only makes it audible.
   ============================================================ */

export function createSfx(){
  let ac=null, master=null, muted=false;
  const listener={x:0,z:0,yaw:0};

  function ensure(){
    if(ac) return ac;
    const AC = window.AudioContext || window.webkitAudioContext;
    if(!AC) return null;
    ac = new AC();
    master = ac.createGain(); master.gain.value = 0.5; master.connect(ac.destination);
    return ac;
  }

  /* Where a sound sits, from the LISTENER's point of view.
     pan is -1..1 across the player's own facing, gain falls with distance and
     goes silent past MAX_D. Both are pure functions of geometry so a test can
     assert them without making a sound. */
  const MAX_D = 120, REF_D = 12;
  function place(x, z){
    const dx = x-listener.x, dz = z-listener.z;
    const dist = Math.hypot(dx, dz);
    if(dist > MAX_D) return null;
    /* bearing relative to where the player is looking (camera forward is
       yaw+PI in the sim's atan2(x,z) convention — the same correction the
       wind compass needs) */
    let rel = Math.atan2(dx, dz) - (listener.yaw + Math.PI);
    while(rel >  Math.PI) rel -= Math.PI*2;
    while(rel < -Math.PI) rel += Math.PI*2;
    /* ⚠️ PAN IS NEGATED, and this is the same trap the wind compass fell into:
       in the sim's atan2(x,z) convention a bearing to your RIGHT is a
       NEGATIVE delta, while StereoPanner's +1 is the right ear. Without the
       minus, everything you hear is on the wrong side of you — which is
       exactly the class of bug §2 records COTW shipping for years. */
    return {
      dist,
      pan:  Math.max(-1, Math.min(1, -Math.sin(rel))),
      front: Math.cos(rel),          // +1 dead ahead, -1 directly behind
      gain: 1 / (1 + Math.pow(dist/REF_D, 1.35))
    };
  }

  function voice(v, x, z){
    if(muted) return null;
    const p = place(x, z); if(!p) return null;
    if(!ensure()) return p;
    if(ac.state === 'suspended') ac.resume();
    const t0 = ac.currentTime;

    const out = ac.createGain(); out.gain.value = p.gain;
    const pan = ac.createStereoPanner(); pan.pan.value = p.pan;
    /* distance eats the top end long before it eats the volume — this is
       most of what makes far things SOUND far */
    const lp = ac.createBiquadFilter();
    lp.type='lowpass';
    lp.frequency.value = Math.max(420, 8200 - p.dist*62);
    out.connect(lp); lp.connect(pan); pan.connect(master);

    for(let i=0;i<v.pulses;i++){
      const t = t0 + i*(v.dur/v.pulses + v.gap);
      const osc = ac.createOscillator();
      osc.type = v.rough > 0.55 ? 'sawtooth' : v.rough > 0.3 ? 'square' : 'triangle';
      osc.frequency.setValueAtTime(v.f0, t);
      osc.frequency.exponentialRampToValueAtTime(
        Math.max(30, v.f0 * (1 + v.sweep)), t + v.dur/v.pulses);
      /* the formant is what stops every creature sounding like a synth */
      const bp = ac.createBiquadFilter();
      bp.type='bandpass'; bp.frequency.value = v.f0*v.formant; bp.Q.value = 1.6+v.rough*5;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.55, t+0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + v.dur/v.pulses);
      osc.connect(bp); bp.connect(g); g.connect(out);
      osc.start(t); osc.stop(t + v.dur/v.pulses + 0.02);
    }
    return p;
  }

  return {
    setListener(x, z, yaw){ listener.x=x; listener.z=z; listener.yaw=yaw; },
    voice,
    /* headless-checkable geometry — the harness §2 demands */
    probe(x, z){ return place(x, z); },
    mute(v){ muted = v===undefined ? !muted : !!v; return muted; },
    get muted(){ return muted; },
    resume(){ const a=ensure(); if(a && a.state==='suspended') a.resume(); }
  };
}
