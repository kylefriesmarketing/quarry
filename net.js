/* ============================================================
   QUARRY net.js — M12 THE PARTY. Three hunters, one world.

   Star lockstep, the Age of Toys pattern: every client runs the SAME
   deterministic sim; only COMMANDS travel. Guests connect to the host,
   the host merges every seat's commands per tick in seat order and
   rebroadcasts the canonical set. A guest never applies its own input
   directly — it applies the echo, so every client executes an identical
   command list at an identical tick.

   ⚠️ The transport is INJECTED. PeerJS is a browser global (index.html
   loads lib/peerjs.min.js); this module never imports it, so the whole
   lockstep engine runs headless in node and the in-memory harness
   (qNetTest, below) is the authoritative determinism test — the live
   two-tab PeerJS run is only the spot check.
   ============================================================ */

import {createSim} from './sim.js';

/* six ticks of input latency absorption at 20Hz = 300ms of slack —
   the extra hop through the host relay is why it is 6, not 3 (AoT) */
export const INPUT_DELAY = 6;
export const HASH_EVERY  = 100;          // lockstep audit cadence (ticks)
export const ROOM_PREFIX = 'quarry-';

/* ---------- the lockstep core (transport-agnostic) ---------- */
export function createLockstep({role, seat, seats}){
  const L = {
    role, seat, seats,
    tick: 0,                 // next tick to EXECUTE
    inTick: 0,               // next tick to STAMP input for
    localQ: [],              // local cmds queued since last flush
    sched: new Map(),        // tick -> canonical [[seat,cmd],...]
    pending: new Map(),      // host: tick -> Map(seat -> cmds[])
    hashes: new Map(),       // host: tick -> Map(seat -> h)
    left: new Set(),
    inSync: true,
    desyncAt: null,
    sendHost: null,          // guest: fn(msg)
    sendGuest: new Map(),    // host: seat -> fn(msg)
    onEvent: null,           // ({t:'desync'|'left', ...})
  };
  /* the first INPUT_DELAY ticks have no one's input by construction */
  for(let t=0; t<INPUT_DELAY; t++) L.sched.set(t, []);

  const liveSeats = () => {
    const s=[]; for(let i=0;i<L.seats;i++) if(!L.left.has(i)) s.push(i);
    return s;
  };
  const finalize = (t) => {                       // host only
    const bucket = L.pending.get(t);
    if(!bucket) return false;
    for(const s of liveSeats()) if(!bucket.has(s)) return false;
    const all = [];
    for(const s of liveSeats()) for(const c of bucket.get(s)) all.push([s, c]);
    L.pending.delete(t);
    L.sched.set(t, all);
    const msg = {t:'tick', tick:t, all};
    for(const fn of L.sendGuest.values()) fn(msg);
    return true;
  };
  const hostTake = (seat, t, cmds) => {
    if(t < L.tick) return;                        // too late — seat dropped it
    if(!L.pending.has(t)) L.pending.set(t, new Map());
    L.pending.get(t).set(seat, cmds || []);
    finalize(t);
  };

  L.queue = (cmd) => { L.localQ.push(cmd); };

  /* once per tick, BEFORE canStep: stamp the queued input for the future */
  L.flush = () => {
    const t = L.inTick + INPUT_DELAY;
    const cmds = L.localQ; L.localQ = [];
    L.inTick++;
    if(L.role==='host') hostTake(L.seat, t, cmds);
    else L.sendHost && L.sendHost({t:'in', seat:L.seat, tick:t, cmds});
  };

  L.canStep = () => L.sched.has(L.tick);

  /* apply the canonical set and advance the sim exactly one lockstep frame */
  L.execTick = (sim) => {
    const all = L.sched.get(L.tick);
    L.sched.delete(L.tick);
    const per = sim.mpTick(all);
    const t = L.tick; L.tick++;
    if(t>0 && t % HASH_EVERY === 0){
      const h = sim.mpFingerprint();
      if(L.role==='host') L.takeHash(L.seat, t, h);
      else L.sendHost && L.sendHost({t:'hash', seat:L.seat, tick:t, h});
    }
    return per;
  };

  L.takeHash = (seat, t, h) => {                  // host only
    if(!L.hashes.has(t)) L.hashes.set(t, new Map());
    const m = L.hashes.get(t); m.set(seat, h);
    if(m.size < liveSeats().length) return;
    const vals = [...m.values()];
    L.hashes.delete(t);
    if(vals.some(v => v !== vals[0])){
      L.inSync = false; L.desyncAt = t;
      const msg = {t:'desync', tick:t};
      for(const fn of L.sendGuest.values()) fn(msg);
      L.onEvent && L.onEvent(msg);
    }
  };

  L.drop = (seat) => {                            // host only: a guest left
    L.left.add(seat);
    /* any tick waiting on that seat can now close */
    for(const t of [...L.pending.keys()].sort((a,b)=>a-b)) finalize(t);
    const msg = {t:'left', seat};
    for(const fn of L.sendGuest.values()) fn(msg);
    L.onEvent && L.onEvent(msg);
  };

  /* one message from the wire */
  L.recv = (msg) => {
    if(L.role==='host'){
      if(msg.t==='in')   hostTake(msg.seat, msg.tick, msg.cmds);
      if(msg.t==='hash') L.takeHash(msg.seat, msg.tick, msg.h);
    } else {
      if(msg.t==='tick')   L.sched.set(msg.tick, msg.all);
      if(msg.t==='left')   { L.left.add(msg.seat); L.onEvent && L.onEvent(msg); }
      if(msg.t==='desync') { L.inSync=false; L.desyncAt=msg.tick; L.onEvent && L.onEvent(msg); }
    }
  };

  return L;
}

/* ---------- PeerJS wiring (browser only; Peer is injected) ----------
   Flow: guests connect and get their seat + the host's world (seed/ground/
   profile) IMMEDIATELY, build it, then send 'ready' with their handshake
   mods. The host starts only when every seat is ready — the seat mods
   array rides in the 'start' message so every client seeds identical
   hunters. Mods are STATIC in-session by design (see sim.js §M12). */
export function hostRoom(Peer, {seats=2, seed, ground=null, profile='balanced', myMods=null}, onEvent){
  return new Promise((resolve, reject)=>{
    const code = Math.random().toString(36).slice(2,6).toUpperCase();
    const peer = new Peer(ROOM_PREFIX+code);
    const conns = [];                       // seat-1 indexed: conns[0] = seat 1
    const room = {code, peer, seats, seed, ground, profile, conns,
                  started:false, L:null, guests:0,
                  ready:new Set(), seatMods:[myMods || {speed:1, noise:0}]};
    let opened = false;
    peer.on('error', e => { if(!opened) reject(e); onEvent && onEvent({t:'error', e}); });
    peer.on('open', ()=>{ opened = true; resolve(room); });
    peer.on('connection', conn=>{
      if(room.started || room.guests >= seats-1){ conn.close(); return; }
      const seat = ++room.guests;
      conns[seat-1] = conn;
      conn.on('open', ()=>{
        conn.send({t:'seat', seat, seats, seed, ground, profile});
        onEvent && onEvent({t:'join', seat, count:room.guests});
      });
      conn.on('data', msg=>{
        if(msg.t==='ready'){
          room.seatMods[seat] = msg.mods || {speed:1, noise:0};
          room.ready.add(seat);
          onEvent && onEvent({t:'ready', seat, ready:room.ready.size, of:room.guests});
        } else room.L && room.L.recv(msg);
      });
      conn.on('close', ()=>{ room.L && room.L.drop(seat); onEvent && onEvent({t:'leave', seat}); });
    });
    room.allReady = ()=> room.guests>0 && room.ready.size===room.guests;
    room.start = ()=>{
      room.started = true;
      const n = 1+room.guests;
      room.L = createLockstep({role:'host', seat:0, seats:n});
      for(let s=1; s<=room.guests; s++){
        const conn = conns[s-1];
        room.L.sendGuest.set(s, m=>conn.send(m));
      }
      const mods = []; for(let s=0;s<n;s++) mods[s]=room.seatMods[s]||{speed:1,noise:0};
      for(const c of conns) c && c.send({t:'start', seats:n, mods});
      room.L.onEvent = e => onEvent && onEvent(e);
      room.mods = mods;
      return room.L;
    };
    room.close = ()=>{ try{ peer.destroy(); }catch(e){} };
  });
}

export function joinRoom(Peer, code, onEvent){
  return new Promise((resolve, reject)=>{
    const peer = new Peer();
    const room = {peer, L:null, seat:null, seats:null,
                  seed:null, ground:null, profile:null, mods:null, onStart:null};
    peer.on('error', e => { reject(e); onEvent && onEvent({t:'error', e}); });
    peer.on('open', ()=>{
      const conn = peer.connect(ROOM_PREFIX+code.toUpperCase(), {reliable:true});
      room.conn = conn;
      conn.on('data', msg=>{
        if(msg.t==='seat'){
          Object.assign(room, {seat:msg.seat, seats:msg.seats, seed:msg.seed,
                               ground:msg.ground, profile:msg.profile});
          resolve(room);                     // world known — go build it
          onEvent && onEvent({t:'seat', seat:msg.seat});
        } else if(msg.t==='start'){
          room.seats = msg.seats; room.mods = msg.mods;
          room.L = createLockstep({role:'guest', seat:room.seat, seats:msg.seats});
          room.L.sendHost = m=>conn.send(m);
          room.L.onEvent = e => onEvent && onEvent(e);
          room.onStart && room.onStart(room.L);
        } else room.L && room.L.recv(msg);
      });
      conn.on('close', ()=>{ onEvent && onEvent({t:'hostgone'}); });
    });
    /* world built — tell the host this seat is good to go */
    room.sendReady = (mods)=> room.conn.send({t:'ready', mods:mods||{speed:1,noise:0}});
    room.close = ()=>{ try{ peer.destroy(); }catch(e){} };
  });
}

/* ============================================================
   THE HARNESS — N real lockstep instances over fake synchronous
   wires driving N real sims. This exercises the actual queue/flush/
   finalize/broadcast/execTick paths, so when it holds, the only thing
   PeerJS can add is latency.  script: [{t, seat, c}] — cmd c queued on
   `seat`'s client at local input tick t.
   ============================================================ */
export function qNetTest({seats=2, seed=7, ground=null, profile='balanced',
                          ticks=600, script=[], dropAt=null}={}){
  const sims = [], nets = [];
  for(let s=0; s<seats; s++){
    const sim = createSim(seed, profile, ground);
    sim.mp = true;
    sim.setHunterCount(seats);
    sims.push(sim);
    nets.push(createLockstep({role: s===0?'host':'guest', seat:s, seats}));
  }
  /* fake wires — synchronous, in order, like AoT's __ttNetTest */
  for(let s=1; s<seats; s++){
    nets[s].sendHost = m => nets[0].recv(JSON.parse(JSON.stringify(m)));
    nets[0].sendGuest.set(s, m => nets[s].recv(JSON.parse(JSON.stringify(m))));
  }
  const bySeatTick = new Map();
  for(const e of script){
    const k = e.seat+':'+e.t;
    if(!bySeatTick.has(k)) bySeatTick.set(k, []);
    bySeatTick.get(k).push(e.c);
  }
  const fps = [];
  let err = null;
  try{
    for(let t=0; t<ticks; t++){
      if(dropAt!=null && t===dropAt && seats>1) nets[0].drop(seats-1);
      for(let s=0; s<seats; s++){
        if(dropAt!=null && s===seats-1 && t>=dropAt) continue;
        const q = bySeatTick.get(s+':'+nets[s].inTick);
        if(q) for(const c of q) nets[s].queue(c);
        nets[s].flush();
      }
      for(let s=0; s<seats; s++){
        if(dropAt!=null && s===seats-1 && t>=dropAt) continue;
        if(!nets[s].canStep()) throw new Error('stalled: seat '+s+' at tick '+t);
        nets[s].execTick(sims[s]);
      }
      if(t % 100 === 0 || t===ticks-1)
        fps.push(sims.map(x=>x.mpFingerprint()));
    }
  }catch(e){ err = String(e && e.message || e); }
  const live = dropAt!=null ? seats-1 : seats;
  const agreed = fps.every(row => row.slice(0, live).every(v => v === row[0]));
  return {
    err, agreed,
    inSync: nets.every((n,i)=> (dropAt!=null && i===seats-1) || n.inSync===true),
    fp: fps.length ? fps[fps.length-1][0] : null,
    ticks: nets[0].tick, sims, nets,
  };
}
