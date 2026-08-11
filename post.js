/* ============================================================
   QUARRY — post.js   (M3, THE MASK)

   The mask IS the interface. Almost no HUD; what you get instead is old
   technology between you and the world — film grain, gate weave, chromatic
   aberration at the frame edges, and scanlines/interlace ONLY inside the
   vision modes, because the optics are the old part.

   PURE VIEW. Never read by the sim, never runs headless.

   ⚠️ COLOUR CORRECTNESS hinges on one three.js fact: WebGLPrograms only
   applies toneMapping when currentRenderTarget === null. So the scene lands
   in the render target as LINEAR HDR, and the composite shader — which DOES
   draw to the canvas — applies ACES + sRGB itself via the tonemapping and
   colorspace includes, with toneMapped = true. That is why the base look is
   unchanged rather than double-graded.
   ⚠️ sceneRT.samples = 4 or post silently costs you the canvas's MSAA and
   everything gets jaggy — a regression that is very easy to ship blind.
   ============================================================ */
import * as THREE from 'three';

const VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const FRAG = `
precision highp float;
varying vec2 vUv;
uniform sampler2D tDiffuse;
uniform float uTime, uAberration, uGrain, uScan, uWeave, uVignette,
              uGlitch, uBlind, uInterlace;
uniform vec2  uRes;

float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main(){
  vec2 uv = vUv;

  /* GATE WEAVE — the frame itself is not quite steady in the gate. Tiny, and
     the eye reads it as "this is film" rather than "this is drifting". */
  uv += vec2(sin(uTime*2.1)*0.0006, cos(uTime*1.7)*0.0005) * uWeave;

  /* TRACKING GLITCH — fired when you switch optics. Whole scanline bands slip
     sideways, the way a tape does when the head loses lock. */
  if(uGlitch > 0.001){
    float band = floor(uv.y * 34.0);
    float slip = (hash(vec2(band, floor(uTime*22.0))) - 0.5);
    if(abs(slip) > 0.5 - uGlitch*0.5) uv.x += slip * uGlitch * 0.14;
  }

  /* CHROMATIC ABERRATION — a real lens fails at its edges, not its centre,
     so this scales with distance from the middle. */
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  vec2 off = c * r2 * uAberration;
  vec3 col;
  col.r = texture2D(tDiffuse, uv + off).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv - off).b;

  /* SCANLINES + INTERLACE — optics only. The mask is old; your eyes are not. */
  if(uScan > 0.001){
    float lines = sin(uv.y * uRes.y * 1.5708);
    col *= 1.0 - uScan * 0.30 * (0.5 + 0.5*lines);
    /* interlace: alternate fields, one of them a frame behind */
    float field = mod(floor(uv.y * uRes.y * 0.5) + floor(uTime * 50.0), 2.0);
    col *= 1.0 - uInterlace * 0.22 * field;
  }

  /* GRAIN — analog, so it lives in the signal, not on top of it */
  float g = hash(uv * uRes + fract(uTime) * 91.7) - 0.5;
  col += g * uGrain;

  /* VIGNETTE — you are looking through something */
  col *= 1.0 - uVignette * smoothstep(0.22, 0.86, r2 * 2.0);

  /* the half-second of blindness while the optic finds its feet */
  col = mix(col, vec3(0.0), uBlind);

  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export function createPost(renderer, scene, camera){
  const gl = renderer.getContext();
  const available = !!(gl && renderer.capabilities.isWebGL2);
  /* ⚠️ uAberration is in UV UNITS, and the offset is c * r2 * uAberration —
     at the corner that is ~0.35 * strength. At 0.85 (the first guess) the
     corners separated by 30% OF THE SCREEN and the world looked like a
     psychedelic poster. 0.010 gives ~4px of fringe at 1280 in the corners and
     none in the middle, which is what a real lens does. Shoot it, don't guess. */
  const p = {
    aberration: 0.010, grain: 0.055, scan: 0.0, weave: 1.0,
    vignette: 0.62, interlace: 0.0
  };

  if(!available){
    return { available:false, p,
      setSize(){}, setOptic(){}, glitch(){}, update(){},
      render(){ renderer.render(scene, camera); } };
  }

  const rt = new THREE.WebGLRenderTarget(1, 1, {
    type: THREE.HalfFloatType,
    colorSpace: THREE.LinearSRGBColorSpace,
    depthBuffer: true, stencilBuffer: false
  });
  rt.samples = 4;   // ⚠️ without this you lose MSAA the moment post turns on

  const uni = {
    tDiffuse:{value:rt.texture}, uTime:{value:0},
    uAberration:{value:p.aberration}, uGrain:{value:p.grain},
    uScan:{value:p.scan}, uWeave:{value:p.weave},
    uVignette:{value:p.vignette}, uGlitch:{value:0}, uBlind:{value:0},
    uInterlace:{value:p.interlace},
    uRes:{value:new THREE.Vector2(1,1)}
  };
  const mat = new THREE.ShaderMaterial({
    uniforms:uni, vertexShader:VERT, fragmentShader:FRAG, depthTest:false,
    depthWrite:false
  });
  mat.toneMapped = true;   // the composite is what draws to the canvas

  /* full-screen triangle — cheaper than a quad and has no diagonal seam */
  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.BufferAttribute(
    new Float32Array([-1,-1,0, 3,-1,0, -1,3,0]), 3));
  tri.setAttribute('uv', new THREE.BufferAttribute(
    new Float32Array([0,0, 2,0, 0,2]), 2));
  const fsScene = new THREE.Scene();
  fsScene.add(new THREE.Mesh(tri, mat));
  const fsCam = new THREE.Camera();

  let glitchT = 0, glitchDur = 0, blindT = 0, blindDur = 0;

  return {
    available:true, p, uniforms:uni,

    setSize(w, h){
      const dpr = renderer.getPixelRatio();
      rt.setSize(Math.max(1, w*dpr|0), Math.max(1, h*dpr|0));
      uni.uRes.value.set(Math.max(1, w*dpr|0), Math.max(1, h*dpr|0));
    },

    /* Switching optics COSTS you: the tape loses tracking and you are blind
       for half a second. That is the whole reason cycling is a decision. */
    glitch(dur=0.5, blind=0.28){
      glitchDur = dur; glitchT = dur;
      blindDur = blind; blindT = blind;
    },

    setOptic(o){
      p.scan      = o===0 ? 0.0 : 0.85;
      p.interlace = o===0 ? 0.0 : 1.0;
      p.grain     = o===0 ? 0.055 : 0.085;
    },

    update(dt, time){
      uni.uTime.value = time;
      if(glitchT > 0){ glitchT = Math.max(0, glitchT - dt);
        uni.uGlitch.value = glitchDur ? glitchT/glitchDur : 0; }
      else uni.uGlitch.value = 0;
      if(blindT > 0){ blindT = Math.max(0, blindT - dt);
        uni.uBlind.value = blindDur ? blindT/blindDur : 0; }
      else uni.uBlind.value = 0;
      uni.uAberration.value = p.aberration;
      uni.uGrain.value      = p.grain;
      uni.uScan.value       = p.scan;
      uni.uWeave.value      = p.weave;
      uni.uVignette.value   = p.vignette;
      uni.uInterlace.value  = p.interlace;
    },

    render(){
      const prev = renderer.getRenderTarget();
      renderer.setRenderTarget(rt);
      renderer.clear();
      renderer.render(scene, camera);      // linear HDR into the target
      renderer.setRenderTarget(prev);
      renderer.render(fsScene, fsCam);     // composite -> canvas, tone mapped here
    }
  };
}
