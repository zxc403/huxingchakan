// Physical day-night sky for Edit3D: a single-scattering atmosphere (Rayleigh + Mie, earth-shadowed
// twilight) baked to a LUT on the CPU whenever the sun moves, plus fbm clouds lit up-sun, a sun disc
// whose colour IS the sun-path transmittance, a geometrically lit moon (real phase), four star
// lattices + the Milky Way, and optional aurora curtains. It also lights the scene: the key
// DirectionalLight (sun by day, moon at night), scene.environment (a PMREM of this sky, re-baked by
// the sky itself whenever it changes) and sky-coloured aerial perspective on every fogged material.
//
//   enableToneMapping({ curve: 'aces' })                 // tonemap.js, first line of createScene
//   const sky = createSky({ hour: 17.2, clouds: 0.38 })
//   const sun = new THREE.DirectionalLight(); sun.castShadow = true; scene.add(sun, sun.target)
//   sky.applyTo(scene, { sun, targets: [ocean] })        // background, env, fog, light; targets get setSun()
//   sky.setHour(12)                                      // everything follows: LUT, light, env, fog
//   asset.registerAnimation('day', { objectId: 'sky', duration: 48, sample: (t) => { sky.setHour((17.2 + t / 2) % 24); sky.update(t) } })
//
// Options (all optional): hour 0–24 (17.2 = golden hour; sun rises 6:00 east, sets 18:00 west),
//   sunElevation 15–88° (noon altitude, 58), clouds 0–0.8 coverage (0.38), cloudScale 0.5–3, cloudSpeed,
//   moonPhase 0–24 h behind the sun (11 ≈ almost full, 12 full, 3 crescent), moonSize° (1.3),
//   stars 0–3 brightness (1.5), aurora 0–2 intensity (0 = off; shows only after dusk),
//   haze 0–5 aerosol (1 = clear marine air), aerialScale (distance multiplier for the fog; 10 makes a
//   200 m scene haze like a 2 km one), turbidity 1–10 (2.4), rayleigh 0.2–4 (1.15),
//   below 'haze' | 'sea' (what shows under the horizon: horizon haze, or the mirrored sky of an ocean),
//   groundColor (albedo the environment uses for ground bounce), seed (cloud field / aurora).
// applyTo(scene, { sun, hemi, targets, background, environment, fog }) wires everything in one call and
//   keeps it wired: every setHour()/set() re-drives the light, env, fog and targets.setSun(dir, radiance).
// Light calibration for enableToneMapping({ curve: 'aces', exposure: 1 }) (sky output is pre-scaled):
//   sun intensity = 5.3 × transmittance (measured: 5.0 noon, 4.1 at 17.2, 1.9 at sunset 17.85, 0 after);
//   moon ≈ 0.6 × lit fraction, blue (0.55, 0.71, 1); environmentIntensity 1; a night-fill HemisphereLight
//   (sky.fill, a child of sky.object) adds the skyglow floor after dusk. tonemap.js adds a scotopic toe
//   once the sun is 1–8° down (lifted, blue-grey darks) — the sky drives it, nothing to call.
// Aerial perspective: applyTo sets scene.fog = sky.fog (a THREE.Fog whose near = -1 is a flag). The fog
//   chunks are patched (THREE.ShaderChunk fog_*) so every built-in and onBeforeCompile material with
//   fog:true fades by per-channel extinction toward THE SKY COLOUR OF ITS VIEW DIRECTION (amber toward
//   a low sun, blue away from it, deep blue at night) read from the sky LUT; the LUT reaches materials
//   through patched ShaderLib/UniformsLib.fog uniforms. Raw ShaderMaterials with fog:true must merge
//   THREE.UniformsLib.fog after createSky(). Ordinary THREE.Fog / FogExp2 keep working unchanged.
// Exposes: object (add it; holds backdrop + pre-pass + fill light), sunDirection, sunColor, sunIntensity,
//   moonDirection, light {direction,color,intensity,isMoon}, envIntensity, ambient {sky,ground,intensity},
//   fog, lut, inscatter(dir) (CPU sky colour), set(options), setHour(h), update(time), stats, dispose().
// Cost: 2 draws (backdrop fullscreen triangle drawn last behind everything with early-z, an empty
//   pre-pass that runs the GPU bakes), 1 tri each. Backdrop ≈ LUT fetch + clouds (5-octave fbm ×2) +
//   night lattices; CPU LUT bake 256×128 ≈ 3–20 ms when the sun moves (stats.lutMs; time-lapse median 7.7 ms), build 9–24 ms; per renderer GPU
//   env bake (256×128 sky + PMREM 64) ≈ 1 ms, aurora march 384×112×48 only at night with aurora > 0.
// Ported from Kimi's world-building template (WebGPU/TSL) to WebGL for Edit3D.
import * as THREE from 'three'

const PI = Math.PI

// ---- the physical constants (metres) — identical to the original atmosphere.js
const R_PLANET = 6371e3
const R_ATMOS = 6471e3
const H_R = 8e3
const H_M = 1.2e3
const BETA_R = [5.5e-6, 13.0e-6, 22.4e-6]
const EYE_ALT = 600
const I_STEPS = 16
const J_STEPS = 6
const SUN_I = 28 // solar irradiance driving the scattering integral
const MULTI_SCATTER = 0.6

// ---- LUT layout: azimuth RELATIVE TO THE SUN (the sky is mirror-symmetric about the sun's vertical
// plane, so only half is integrated), elevation sqrt-warped from just under the horizon to the zenith.
const LUT_W = 256
const LUT_H = 128
const LUT_ROWS = LUT_H + 2 // + a guard row + a parameter row read by the fog chunk
const EL_MIN = -0.012

// ---- calibration (see header). The original world renders ACES at exposure 0.85; the sky is
// pre-multiplied by that so tonemap.js runs at exposure 1 for everyone.
const SKY_GAIN = 0.85
const SUN_K = 2 * PI * SKY_GAIN // island.js: sunRadiance 2.0 × NdL  ==  three's I·NdL/π
const MOON_K = 0.62
const MOON_LIGHT = [0.548, 0.71, 1.0]

const AUR_W = 384
const AUR_H = 112
const ENV_W = 256
const ENV_H = 128

const smooth = (e0, e1, x) => { const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1); return t * t * (3 - 2 * t) }

// hour → direction on a simple solar arc: rise east at 6h, set west at 18h
export function celestialDir(hour, maxElevationDeg, out = new THREE.Vector3()) {
  const el = maxElevationDeg * PI / 180 * Math.sin((hour - 6) / 12 * PI)
  const az = (90 + (hour - 6) * 15) * PI / 180
  return out.set(Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az))
}

// ---------------------------------------------------------------------------------------------------
// CPU: optical depth toward the sun, tabulated once. The original marches 6 midpoint samples from
// every primary sample to the top of the atmosphere; that quantity depends only on the sample's radius
// and the sun's cosine there, so it is a 2D table (with exactly the same 6-step quadrature, so the
// tuned look survives) and the per-bake work drops to one bilinear fetch per primary sample.
const OD_NH = 64, OD_NMU = 384
let OD_TABLE = null
function odTable() {
  if (OD_TABLE) return OD_TABLE
  OD_TABLE = new Float32Array(OD_NH * OD_NMU * 2)
  for (let i = 0; i < OD_NH; i++) {
    const x = i / (OD_NH - 1), r = R_PLANET + x * x * 100e3
    for (let j = 0; j < OD_NMU; j++) {
      const y = j / (OD_NMU - 1) * 2 - 1, mu = Math.sign(y) * y * y
      const b = r * mu, t1 = -b + Math.sqrt(Math.max(b * b - r * r + R_ATMOS * R_ATMOS, 0)), js = t1 / J_STEPS
      let oR = 0, oM = 0
      for (let k = 0; k < J_STEPS; k++) {
        const t = (k + 0.5) * js, hj = Math.sqrt(r * r + 2 * b * t + t * t) - R_PLANET
        oR += Math.exp(-hj / H_R) * js; oM += Math.exp(-hj / H_M) * js
      }
      const o = (i * OD_NMU + j) * 2
      OD_TABLE[o] = Math.min(oR, 1e12); OD_TABLE[o + 1] = Math.min(oM, 1e12)
    }
  }
  return OD_TABLE
}

// The scattering integral for every LUT texel. Writes RGBA floats (alpha 1) into `out`.
function bakeScattering(out, sunY, betaR, betaM, mieG) {
  const T = odTable()
  const sx = Math.sqrt(Math.max(1 - sunY * sunY, 0)), sy = sunY // sun in the sun-relative frame (x, y, 0)
  const r0 = R_PLANET + EYE_ALT
  const g = mieG, gg = g * g
  const bR0 = betaR[0], bR1 = betaR[1], bR2 = betaR[2]
  const night = smooth(0.04, -0.14, sunY)
  const shadowLo = R_PLANET * 0.9986, shadowHi = R_PLANET * 1.0022
  const elSpan = PI / 2 - EL_MIN
  for (let col = 0; col < LUT_W / 2; col++) {
    const a = ((col + 0.5) / LUT_W - 0.5) * 2 * PI
    const ca = Math.cos(a), sa = Math.sin(a)
    for (let row = 0; row < LUT_H; row++) {
      const v = row / (LUT_H - 1), el = EL_MIN + v * v * elSpan
      const ce = Math.cos(el), dx = ce * ca, dy = Math.sin(el), dz = ce * sa
      // view ray to the top of the atmosphere, or to the ground
      const b = r0 * dy
      let tEnd = -b + Math.sqrt(Math.max(b * b - r0 * r0 + R_ATMOS * R_ATMOS, 0))
      const discG = b * b - r0 * r0 + R_PLANET * R_PLANET
      if (discG >= 0) { const t0 = -b - Math.sqrt(discG); if (t0 >= 0) tEnd = Math.min(tEnd, t0) }
      const iStep = tEnd / I_STEPS
      let odR = 0, odM = 0, tR0 = 0, tR1 = 0, tR2 = 0, tM0 = 0, tM1 = 0, tM2 = 0
      for (let i = 0; i < I_STEPS; i++) {
        const t = (i + 0.5) * iStep
        const px = dx * t, py = r0 + dy * t, pz = dz * t
        const r = Math.sqrt(px * px + py * py + pz * pz), h = r - R_PLANET
        const dR = Math.exp(-h / H_R) * iStep, dM = Math.exp(-h / H_M) * iStep
        odR += dR; odM += dM
        const proj = px * sx + py * sy
        let lit = 1
        if (proj <= 0) {
          const perp = Math.sqrt(Math.max(r * r - proj * proj, 0))
          lit = perp <= shadowLo ? 0 : perp >= shadowHi ? 1 : smooth(shadowLo, shadowHi, perp)
          if (lit === 0) continue
        }
        // bilinear optical depth toward the sun
        const mu = proj / r
        const fx = Math.sqrt(Math.min(Math.max(h / 100e3, 0), 1)) * (OD_NH - 1)
        const fy = (Math.sign(mu) * Math.sqrt(Math.abs(mu)) + 1) * 0.5 * (OD_NMU - 1)
        const ix = Math.min(fx | 0, OD_NH - 2), iy = Math.min(fy | 0, OD_NMU - 2), wx = fx - ix, wy = fy - iy
        const o00 = (ix * OD_NMU + iy) * 2, o01 = o00 + 2, o10 = o00 + OD_NMU * 2, o11 = o10 + 2
        const w00 = (1 - wx) * (1 - wy), w01 = (1 - wx) * wy, w10 = wx * (1 - wy), w11 = wx * wy
        const jR = T[o00] * w00 + T[o01] * w01 + T[o10] * w10 + T[o11] * w11
        const jM = T[o00 + 1] * w00 + T[o01 + 1] * w01 + T[o10 + 1] * w10 + T[o11 + 1] * w11
        const eM = Math.exp(-betaM * (odM + jM)) * lit, oR = odR + jR
        const a0 = Math.exp(-bR0 * oR) * eM, a1 = Math.exp(-bR1 * oR) * eM, a2 = Math.exp(-bR2 * oR) * eM
        tR0 += dR * a0; tR1 += dR * a1; tR2 += dR * a2
        tM0 += dM * a0; tM1 += dM * a1; tM2 += dM * a2
      }
      const mu = dx * sx + dy * sy, mumu = mu * mu
      const pR = 3 / (16 * PI) * (1 + mumu)
      const pM = 3 / (8 * PI) * (1 - gg) * (1 + mumu) / (Math.pow(1 + gg - 2 * mu * g, 1.5) * (gg + 2))
      const k = MULTI_SCATTER / (4 * PI)
      const sR0 = bR0 * tR0, sR1 = bR1 * tR1, sR2 = bR2 * tR2, sM0 = betaM * tM0, sM1 = betaM * tM1, sM2 = betaM * tM2
      // airglow, folded into the LUT: brightest at the horizon (a thin emitting shell seen edge-on)
      const glow = night * (Math.exp(-3 * Math.max(dy, 0)) * 0.85 + 0.30)
      const L0 = SUN_I * (sR0 * pR + sM0 * pM + (sR0 + sM0) * k) + 0.0026 * glow
      const L1 = SUN_I * (sR1 * pR + sM1 * pM + (sR1 + sM1) * k) + 0.0044 * glow
      const L2 = SUN_I * (sR2 * pR + sM2 * pM + (sR2 + sM2) * k) + 0.0060 * glow
      const o1 = (row * LUT_W + col) * 4, o2 = (row * LUT_W + (LUT_W - 1 - col)) * 4
      out[o1] = out[o2] = L0; out[o1 + 1] = out[o2 + 1] = L1; out[o1 + 2] = out[o2 + 2] = L2; out[o1 + 3] = out[o2 + 3] = 1
    }
  }
  out.copyWithin(LUT_H * LUT_W * 4, (LUT_H - 1) * LUT_W * 4, LUT_H * LUT_W * 4) // guard row
}

// ---------------------------------------------------------------------------------------------------
// GLSL shared by the backdrop, the environment bake and the fog chunk.
const GLSL_LUT = /* glsl */`
#define SKY_PI 3.14159265359
vec2 skyLutUV( vec3 d, float sunAz ) {
  float u = ( atan( d.z, d.x ) - sunAz ) * ( 0.5 / SKY_PI ) + 0.5;
  float el = asin( clamp( d.y, -1.0, 1.0 ) );
  float v = sqrt( clamp( ( el - (${EL_MIN.toFixed(4)}) ) / ( 0.5 * SKY_PI - (${EL_MIN.toFixed(4)}) ), 0.0, 1.0 ) );
  return vec2( u, ( 0.5 + v * ${(LUT_H - 1).toFixed(1)} ) / ${LUT_ROWS.toFixed(1)} );
}
// The sky's own shoulder: one factor from the brightest channel compresses the range and keeps the
// ratios, so a sunset stays amber under ACES instead of being painted cream.
vec3 skyShoulder( vec3 c ) {
  float m = max( max( c.r, c.g ), c.b );
  float soft = min( m, 0.75 ) + 1.65 * ( 1.0 - exp( -max( m - 0.75, 0.0 ) / 1.65 ) );
  return c * ( soft / max( m, 1e-5 ) );
}
// moonlight in-scatter: a cheap cool Rayleigh copy — blue whatever colour the moon is
vec3 skyMoonGlow( vec3 dir, vec3 moonDir, float moonNight ) {
  float cosM = dot( dir, moonDir );
  float horizonExt = smoothstep( -0.05, 0.22, dir.y );
  return vec3( 0.055, 0.075, 0.13 ) * ( 1.0 + cosM * cosM ) * pow( max( moonDir.y, 0.0 ), 0.4 )
    * ( horizonExt * 0.8 + 0.2 ) * moonNight * 0.09;
}
`

// ---- aerial perspective through the stock fog chunks ---------------------------------------------
const FOG_PARS_VERTEX_ADD = '\n#ifdef USE_FOG\n\tvarying vec3 vSkyFogDelta;\n#endif\n'
const FOG_VERTEX_ADD = '\n#ifdef USE_FOG\n\tvSkyFogDelta = mvPosition.xyz * mat3( viewMatrix ); // camera → fragment, world axes\n#endif\n'
const FOG_PARS_FRAGMENT_ADD = /* glsl */`
#ifdef USE_FOG
varying vec3 vSkyFogDelta;
uniform sampler2D skyAerialLut;
${GLSL_LUT}
// Extinction toward the sky in the VIEW direction (not one fog colour): far land goes blue at noon,
// amber toward a low sun, and the horizon matches the backdrop because it is the same LUT.
vec3 skyAerial( vec3 col, vec3 delta, float scale ) {
  vec4 p0 = texelFetch( skyAerialLut, ivec2( 0, ${LUT_H + 1} ), 0 ); // sun dir, sky gain
  vec4 p1 = texelFetch( skyAerialLut, ivec2( 1, ${LUT_H + 1} ), 0 ); // extinction ×1e4 per metre
  vec4 p2 = texelFetch( skyAerialLut, ivec2( 2, ${LUT_H + 1} ), 0 ); // moon dir, moon level × night
  float dist = length( delta );
  vec3 dir = delta / max( dist, 1e-4 );
  float meanY = max( cameraPosition.y + 0.5 * delta.y, 0.0 ); // haze thins with altitude
  float rho = exp( -meanY / 900.0 ) * 0.86 + 0.14;
  vec3 trans = exp( -p1.rgb * ( 1e-4 * dist * scale * rho ) );
  vec3 d = normalize( vec3( dir.x + 1e-5, max( dir.y, 0.0 ), dir.z ) );
  vec3 ins = texture2D( skyAerialLut, skyLutUV( d, atan( p0.z, p0.x ) ) ).rgb + skyMoonGlow( d, p2.xyz, p2.w );
  return col * trans + skyShoulder( ins ) * p0.w * ( 1.0 - trans );
}
#endif
`
const FOG_FRAGMENT = /* glsl */`
#ifdef USE_FOG
	#ifdef FOG_EXP2
		float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
		gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
	#else
		if ( fogNear < 0.0 ) {
			gl_FragColor.rgb = skyAerial( gl_FragColor.rgb, vSkyFogDelta, fogFar ); // sky.fog: near = -1, far = scale
		} else {
			float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
			gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
		}
	#endif
#endif
`
let fogPatched = false
function installAerialChunks() {
  if (fogPatched) return
  fogPatched = true
  const C = THREE.ShaderChunk
  C.fog_pars_vertex += FOG_PARS_VERTEX_ADD
  C.fog_vertex += FOG_VERTEX_ADD
  C.fog_pars_fragment += FOG_PARS_FRAGMENT_ADD
  C.fog_fragment = FOG_FRAGMENT
}
// The LUT has to be a uniform of every fogged material. Built-in materials copy ShaderLib uniforms when
// they compile (a texture clone shares the original's GPU data), so the slot goes there; re-asserted by
// the pre-pass each frame so materials always compile against the sky that is rendering.
function provideAerialUniform(texture) {
  for (const key of Object.keys(THREE.ShaderLib)) {
    const u = THREE.ShaderLib[key].uniforms
    if (u && u.fogColor) { if (!u.skyAerialLut) u.skyAerialLut = { value: texture }; else u.skyAerialLut.value = texture }
  }
  const f = THREE.UniformsLib.fog
  if (!f.skyAerialLut) f.skyAerialLut = { value: texture }; else f.skyAerialLut.value = texture
}

// ---------------------------------------------------------------------------------------------------
// The sky as a function of direction (backdrop and environment). SKY_ENV drops the sharp things the
// environment must not carry: the sun disc (the DirectionalLight is the sun), the moon disc, the stars.
const GLSL_SKY = /* glsl */`
uniform sampler2D uLut;
uniform sampler2D uAurora;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform vec3 uSunColor;     // transmittance × above-horizon
uniform vec3 uMoonColor;
uniform vec3 uGroundRad;
uniform vec2 uSeed;
uniform float uSunAz;
uniform float uSunCosR;
uniform float uMoonCosR;
uniform float uMoonBrightness;
uniform float uMoonLevel;
uniform float uNight;
uniform float uStarDens;
uniform float uStarBrightness;
uniform float uStarRot;
uniform float uTime;
uniform float uCloudTime;
uniform float uCloudCoverage;
uniform float uCloudScale;
uniform float uCloudSpeed;
uniform float uCloudOpacity;
uniform float uAuroraLevel;
uniform float uGain;
uniform float uSeaLevel;
${GLSL_LUT}
vec3 lutAt( vec3 d ) { return texture2D( uLut, skyLutUV( d, uSunAz ) ).rgb; }

float hash2( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 ); }
float noise2( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ), ff = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( hash2( i ), hash2( i + vec2( 1.0, 0.0 ) ), ff.x ), mix( hash2( i + vec2( 0.0, 1.0 ) ), hash2( i + vec2( 1.0 ) ), ff.x ), ff.y );
}
vec2 rotq( vec2 q, float s ) { return vec2( q.x * 0.8 - q.y * 0.6, q.x * 0.6 + q.y * 0.8 ) * s; }
float fbm( vec2 p ) {
  float f = noise2( p ) * 0.5; p = rotq( p, 2.02 );
  f += noise2( p ) * 0.25; p = rotq( p, 2.03 );
  f += noise2( p ) * 0.125; p = rotq( p, 2.01 );
  f += noise2( p ) * 0.0625; p = rotq( p, 2.04 );
  f += noise2( p ) * 0.03125;
  return f / 0.96875;
}

#ifndef SKY_ENV
// ---- the night sky: four star lattices (bright-and-sparse → faint-and-dense) and the Milky Way
float starHash( vec2 p ) {
  vec3 q = fract( vec3( p.x, p.y, p.x ) * 0.1031 );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
}
float starNoise( vec2 p ) {
  vec2 i = floor( p ), f = fract( p ), ff = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( starHash( i ), starHash( i + vec2( 1.0, 0.0 ) ), ff.x ), mix( starHash( i + vec2( 0.0, 1.0 ) ), starHash( i + vec2( 1.0 ) ), ff.x ), ff.y );
}
vec3 starTint( float t ) {
  return mix( mix( vec3( 1.0, 0.55, 0.28 ), vec3( 1.0, 0.96, 0.92 ), clamp( t * 2.2, 0.0, 1.0 ) ), vec3( 0.55, 0.70, 1.0 ), clamp( t * 2.4 - 1.4, 0.0, 1.0 ) );
}
vec2 turn( vec2 q, float c, float s, float k ) { return vec2( q.x * c - q.y * s, q.x * s + q.y * c ) * k; }
vec3 starLayer( float theta, float phi, float sinT, float dens, float clump, float band, float s, float i ) {
  float dim = ( 0.055 - 0.0475 * s ) * SKY_PI;
  float KC = 1500.0 + 1900.0 * s, KH = 300.0 + 240.0 * s;
  float keepP = clamp( dens * ( clump * ( 0.42 + 0.30 * s ) + band * ( 0.12 + 0.34 * s ) ), 0.0, 1.0 );
  vec2 q = vec2( theta / dim + i * 0.37, phi / dim + i * 0.91 );
  vec2 cell = floor( q ), local = fract( q ) - 0.5;
  float hx = starHash( cell + 11.0 + i * 17.3 );
  float hy = starHash( cell + vec2( 91.7, 43.1 ) + i * 5.0 );
  float hp = starHash( cell + vec2( 311.0, 157.0 ) + i * 3.0 );
  float ht = starHash( cell + vec2( 57.3, 233.9 ) + i * 7.0 );
  float hm = starHash( cell + vec2( 613.0, 71.9 ) + i * 11.0 );
  vec2 dd = local - ( vec2( hx, hy ) - 0.5 ) * 0.94;
  float l = length( vec2( dd.x, dd.y * sinT ) ) * dim;
  float keep = step( hp, sinT ) * step( ht, keepP );
  float mag = mix( pow( hm, 5.0 ) * 8.5 + 0.22, pow( hm, 4.0 ) * 0.75 + 0.03, s );
  float tw = sin( uTime * ( hx * 3.0 + 1.4 ) + hp * 39.0 ) * 0.16 + 0.86;
  float shape = exp( -l * KC ) + exp( -l * KH ) * 0.055;
  return starTint( hx * hx ) * ( shape * mag * tw * keep );
}
const vec3 GAL_N = vec3( 0.641, 0.451, -0.621 );
const vec3 GAL_C = vec3( 0.179, 0.699, 0.692 );
const vec3 GAL_A = vec3( 0.746, -0.555, 0.367 );
vec3 nightSky( vec3 dir ) {
  float ca = cos( uStarRot ), sa = sin( uStarRot );
  vec3 d = vec3( dir.x * ca + dir.z * sa, dir.y, dir.z * ca - dir.x * sa );
  float theta = acos( clamp( d.y, -1.0, 1.0 ) );
  float phi = atan( d.z, d.x );
  float sinT = max( sin( theta ), 0.04 );
  float lat = asin( clamp( dot( d, GAL_N ), -1.0, 1.0 ) );
  float band = exp( -lat * lat * 20.0 );
  float dens = clamp( ( 1.0 - uStarDens ) / 0.016, 0.0, 2.0 );
  float clump = starNoise( vec2( d.x + d.y * 0.6, d.z - d.y * 0.4 ) * 2.4 ) * 0.90 + 0.55;
  vec3 col = starLayer( theta, phi, sinT, dens, clump, band, 0.0, 0.0 )
    + starLayer( theta, phi, sinT, dens, clump, band, 1.0 / 3.0, 1.0 )
    + starLayer( theta, phi, sinT, dens, clump, band, 2.0 / 3.0, 2.0 )
    + starLayer( theta, phi, sinT, dens, clump, band, 1.0, 3.0 );
  col *= 1.0 - 0.45 * uMoonLevel; // a bright moon washes the faint sky out
  // the Galaxy: radians on both axes (isotropic structure), every octave rotated (no quilting)
  float gu = atan( dot( d, GAL_A ), dot( d, GAL_C ) );
  vec2 gp = vec2( gu, lat );
  vec2 gw = gp + ( vec2( starNoise( turn( gp, 0.80, 0.60, 2.3 ) ), starNoise( turn( gp, 0.28, -0.96, 2.6 ) + 19.0 ) ) - 0.5 ) * 0.30;
  float clouds = starNoise( gw * 3.1 ) * 0.50 + starNoise( turn( gw, 0.62, 0.78, 7.7 ) + 11.0 ) * 0.31
    + starNoise( turn( gw, -0.31, 0.95, 17.3 ) + 29.0 ) * 0.19;
  float prof = exp( -pow( lat * 5.0, 2.0 ) );
  float lon = exp( -gu * gu * 0.55 ) * 0.62 + 0.38;
  float riftY = ( lat - sin( gu * 1.7 ) * 0.030 ) * 22.0;
  float rift = 1.0 - 0.78 * exp( -riftY * riftY );
  float bulge = exp( -gu * gu * 2.6 ) * exp( -pow( lat * 8.0, 2.0 ) );
  float grain = starNoise( turn( gp, 0.71, -0.71, 46.0 ) + 7.0 ) * 0.30 + 0.85;
  float cs = smoothstep( 0.22, 0.84, clouds );
  float glow = ( prof * lon * rift * ( cs * 1.55 + 0.14 ) * 0.072 + bulge * 0.17 ) * grain;
  vec3 dust = mix( vec3( 0.90, 0.68, 0.50 ), vec3( 0.60, 0.72, 1.00 ), cs );
  col += mix( dust, vec3( 1.00, 0.86, 0.64 ), bulge ) * glow * ( 1.0 - 0.62 * uMoonLevel );
  return col;
}
#endif

vec2 auroraUV( vec3 d ) {
  return vec2( atan( d.z, d.x ) * ( 0.5 / SKY_PI ) + 0.5, sqrt( asin( clamp( d.y, 0.0, 1.0 ) ) / ( 0.5 * SKY_PI ) ) );
}

// the sky above the horizon, before uGain
vec3 skyColor( vec3 dir ) {
  vec3 col = lutAt( dir );
  float cosS = dot( dir, uSunDir );
  float cosM = dot( dir, uMoonDir );
  float night = uNight;
  float horizonExt = smoothstep( -0.05, 0.22, dir.y );
  if ( night > 0.003 ) {
#ifndef SKY_ENV
    col += nightSky( dir ) * uStarBrightness * night * horizonExt;
#endif
    if ( uAuroraLevel > 0.0 ) col += texture2D( uAurora, auroraUV( dir ) ).rgb * uAuroraLevel * night;
    col += skyMoonGlow( dir, uMoonDir, uMoonLevel * night );
    // the aureole is Mie: it carries the moon's own colour and dies within a few degrees
    float cm = max( cosM, 0.0 );
    col += uMoonColor * ( pow( cm, 220.0 ) * 0.90 + pow( cm, 26.0 ) * 0.055 ) * uMoonLevel * night * 0.38;
  }
#ifndef SKY_ENV
  // the moon: a sphere lit by the actual sun direction — the phase and terminator are geometry
  float alphaM = smoothstep( uMoonCosR, uMoonCosR + 0.00012, cosM );
  if ( alphaM > 0.0 ) {
    vec3 t1 = normalize( cross( uMoonDir, vec3( 0.0001, 1.0001, 0.0001 ) ) );
    vec3 t2 = cross( t1, uMoonDir );
    float sinR = sqrt( 1.0 - uMoonCosR * uMoonCosR );
    vec3 q = dir - uMoonDir * cosM;
    float mu = dot( q, t1 ) / sinR, mv = dot( q, t2 ) / sinR;
    float r2 = clamp( mu * mu + mv * mv, 0.0, 1.0 );
    vec3 n = t1 * mu + t2 * mv - uMoonDir * sqrt( 1.0 - r2 );
    float lit = max( dot( n, uSunDir ), 0.0 );
    float maria = ( 0.72 + noise2( vec2( mu, mv ) * 3.1 + 7.3 ) * 0.28 ) * ( 0.86 + noise2( vec2( mu, mv ) * 8.7 + 2.1 ) * 0.14 );
    vec3 surface = uMoonColor * ( lit * 0.80 + 0.015 ) * maria * uMoonBrightness * smoothstep( -0.04, 0.06, dir.y );
    col = mix( col, surface, alphaM );
  }
  col += uMoonColor * pow( max( cosM, 0.0 ), 900.0 ) * uMoonLevel * 0.12;
#endif
  // the sun's radiance: sunColor's hue, pinned just over the shoulder's ceiling (composited last)
  float peak = max( max( uSunColor.r, uSunColor.g ), uSunColor.b );
  float aboveH = smoothstep( -0.012, 0.004, uSunDir.y );
  vec3 sunRad = uSunColor / max( peak, 1e-4 ) * ( 2.4 * 1.9 ) * aboveH;

  // ---- clouds: an fbm slab on a curved shell, lit by marching the noise up-sun (Beer + powder)
  float cy = max( dir.y, 0.012 );
  float shell = min( 1.0 / ( cy + cy * cy * 0.9 ), 30.0 );
  vec2 cuv = dir.xz * ( shell * uCloudScale * 3.2 ) + vec2( 0.006, 0.0023 ) * uCloudTime * uCloudSpeed + uSeed;
  float thr = 0.90 - uCloudCoverage;
  float cover = 0.0;
  vec3 cloudCol = vec3( 0.0 );
  if ( uCloudCoverage > 0.0 && dir.y > 0.0 ) {
    float den = fbm( cuv ) - fbm( cuv * 3.7 + 5.1 ) * 0.22;
    cover = smoothstep( thr, thr + 0.20, den ) * smoothstep( 0.0, 0.055, dir.y ) * uCloudOpacity;
    if ( cover > 0.004 ) {
      vec2 sunUV = normalize( uSunDir.xz + 1e-4 );
      float d1 = smoothstep( thr, thr + 0.20, fbm( cuv + sunUV * 0.20 ) );
      float d2 = smoothstep( thr, thr + 0.20, fbm( cuv + sunUV * 0.52 ) );
      float beer = exp( -( d1 * 0.62 + d2 * 0.38 ) * 2.6 );
      float powder = 1.0 - exp( -cover * 3.0 );
      float cs = max( cosS, 0.0 );
      float hg = pow( cs, 6.0 ) * 0.8 + pow( cs, 48.0 ) * 2.6;
      vec3 cloudLit = uSunColor * ${SUN_I.toFixed(1)} * aboveH * ( beer * ( powder * 0.6 + 0.4 ) * ( hg + 0.9 ) ) * 0.058;
      // ambient from the sky the cloud sits in: a low cloud over a burning horizon is lit orange
      vec3 cloudAmb = lutAt( vec3( dir.x, max( dir.y, 0.09 ), dir.z ) ) * 0.7 + vec3( 0.03, 0.04, 0.07 ) * uMoonLevel * night * 0.4;
      cloudCol = cloudLit + cloudAmb * ( beer * 0.4 + 0.6 );
      cloudCol = mix( cloudCol, col, smoothstep( 0.30, 0.015, dir.y ) * 0.85 ); // far clouds dissolve
    }
  }
  vec3 sky = skyShoulder( mix( col, cloudCol, cover ) );
#ifndef SKY_ENV
  float clear = 1.0 - cover;
  float disc = smoothstep( uSunCosR, uSunCosR + 0.00010, cosS );
  sky = mix( sky, sunRad, disc * clear );
  float cs2 = max( cosS, 0.0 );
  sky += sunRad * peak * ( pow( cs2, 2200.0 ) * 0.55 + pow( cs2, 180.0 ) * 0.07 ) * clear;
#endif
  return sky;
}

// below the horizon: the horizon haze of that azimuth (what the aerial perspective converges to),
// or for an ocean the sky it mirrors, hazed over the range the ray travels (eyeHeight / |dir.y|)
vec3 skyBelow( vec3 d ) {
  vec3 hz = vec3( d.x, 0.0, d.z ) + vec3( 1e-5, 0.0, 0.0 );
  vec3 horizon = lutAt( normalize( hz ) ) + skyMoonGlow( normalize( hz ), uMoonDir, uMoonLevel * uNight );
#ifdef SKY_SEA
  float down = max( -d.y, 1e-4 );
  float range = max( cameraPosition.y - uSeaLevel, 0.5 ) / down;
  vec3 mirror = lutAt( normalize( vec3( d.x, down, d.z ) ) );
  return skyShoulder( mix( horizon, mirror * 0.92, exp( -range / 26000.0 ) ) );
#else
  return skyShoulder( horizon );
#endif
}
`

const FULLSCREEN_VERT = /* glsl */`
void main() { gl_Position = vec4( position.xy, 0.0, 1.0 ); }
`

const BACKDROP_VERT = /* glsl */`
varying vec3 vSkyDir;
void main() {
  vec4 farPoint = inverse( projectionMatrix ) * vec4( position.xy, 1.0, 1.0 );
  vSkyDir = ( farPoint.xyz / farPoint.w ) * mat3( viewMatrix ); // view ray in world axes
  gl_Position = vec4( position.xy, 1.0, 1.0 );                  // on the far plane: behind everything
}
`
const BACKDROP_FRAG = /* glsl */`
varying vec3 vSkyDir;
${GLSL_SKY}
void main() {
  vec3 d = normalize( vSkyDir );
  vec3 c = d.y < 0.0 ? skyBelow( d ) : skyColor( d );
  gl_FragColor = vec4( c * uGain, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb += ( fract( 52.9829189 * fract( dot( gl_FragCoord.xy, vec2( 0.06711056, 0.00583715 ) ) ) ) - 0.5 ) / 255.0;
}
`
const ENV_FRAG = /* glsl */`
#define SKY_ENV
${GLSL_SKY}
void main() {
  vec2 uv = gl_FragCoord.xy / vec2( ${ENV_W.toFixed(1)}, ${ENV_H.toFixed(1)} );
  float phi = ( uv.x - 0.5 ) * 2.0 * SKY_PI, theta = ( uv.y - 0.5 ) * SKY_PI;
  vec3 d = vec3( cos( theta ) * cos( phi ), sin( theta ), cos( theta ) * sin( phi ) );
  vec3 c;
  if ( d.y >= 0.0 ) c = skyColor( d ) * uGain;
  else c = mix( skyBelow( d ) * uGain, uGroundRad, smoothstep( 0.0, 0.12, -d.y ) ); // ground bounce
  gl_FragColor = vec4( c, 1.0 );
}
`

// ---- aurora curtains: a 75 m slab warped by 3-D value noise, marched into a direction LUT ----------
const AURORA_FRAG = /* glsl */`
#define SKY_PI 3.14159265359
uniform float aTime, aSpeed, aSeed, aGain;
uniform vec3 aColorBase, aColorHigh;
float hash1( float v ) { vec3 p = fract( vec3( v ) * 0.1031 ); p += dot( p, p.yzx + 19.19 ); return fract( ( p.x + p.y ) * p.z ); }
float hash3( vec3 v ) { vec3 p = fract( v * vec3( 0.1031, 0.1030, 0.0973 ) ); p += dot( p, p.yxz + 33.33 ); return fract( ( p.xxy + p.yxx ) * p.zyx ).x; }
float valueNoise3( vec3 c ) {
  vec3 g = floor( c ), f = fract( c ); f = f * f * ( 3.0 - 2.0 * f );
  return mix(
    mix( mix( hash3( g ), hash3( g + vec3( 1, 0, 0 ) ), f.x ), mix( hash3( g + vec3( 0, 1, 0 ) ), hash3( g + vec3( 1, 1, 0 ) ), f.x ), f.y ),
    mix( mix( hash3( g + vec3( 0, 0, 1 ) ), hash3( g + vec3( 1, 0, 1 ) ), f.x ), mix( hash3( g + vec3( 0, 1, 1 ) ), hash3( g + vec3( 1, 1, 1 ) ), f.x ), f.y ), f.z );
}
// a 1D noise whose slope sign comes from a hash parity: a kinked, folded line (the curtain wobble)
float pickGradient( float h, float v ) { return mod( floor( h * 1e4 ), 2.0 ) < 0.5 ? v : -v; }
float lineNoise( float pt ) {
  float i = floor( pt ), f = pt - i, w = f * f * f * ( f * ( f * 6.0 - 15.0 ) + 10.0 );
  return mix( pickGradient( hash1( i ), f ), pickGradient( hash1( i + 1.0 ), f - 1.0 ), w ) * 2.0;
}
float fractalVolume( vec3 p ) {
  float acc = ( 1.0 - valueNoise3( p ) ) + ( 1.0 - valueNoise3( p * 2.0 ) ) * 0.5 + ( 1.0 - valueNoise3( p * 4.0 ) ) * 0.25;
  return clamp( acc / 1.75, 0.0, 1.0 );
}
float density( vec3 p ) {
  float t = aTime * aSpeed;
  float nh = ( p.y - 50.0 ) / 75.0;
  vec3 sp = vec3( p.x, t * 2.0, p.z * 0.225 + t * 0.5 ) * 0.04;
  sp.x += aSeed * 17.3 + nh * 0.3 + cos( p.z * 0.005 ) * 5.5 + lineNoise( p.z * 0.1 + t * 2.0 ) * 0.02;
  sp.z += aSeed * 29.1;
  float base = fractalVolume( sp );
  vec3 sq = vec3( base, ( p.y - 50.0 ) * 0.006 + 0.48, base );
  sq.y += lineNoise( t + sp.z ) * 0.015 + lineNoise( -2.0 * t + sp.z ) * 0.015;
  return max( pow( 0.55 / max( length( sq ), 1e-7 ), 12.0 ) * cos( sp.x * 0.13 ), 0.0 );
}
void main() {
  vec2 uv = gl_FragCoord.xy / vec2( ${AUR_W.toFixed(1)}, ${AUR_H.toFixed(1)} );
  float az = ( uv.x - 0.5 ) * 2.0 * SKY_PI, el = uv.y * uv.y * 0.5 * SKY_PI;
  vec3 dir = vec3( cos( el ) * cos( az ), sin( el ), cos( el ) * sin( az ) );
  vec3 origin = vec3( 0.0, 10.0, 0.0 ) + dir * 10.0;
  vec3 inv = 1.0 / dir;
  vec3 tA = ( vec3( -250.0, 50.0, -500.0 ) - origin ) * inv, tB = ( vec3( 250.0, 125.0, 500.0 ) - origin ) * inv;
  vec3 tmin = min( tA, tB ), tmax = max( tA, tB );
  float near = max( max( tmin.x, tmin.y ), tmin.z ), far = min( min( tmax.x, tmax.y ), tmax.z );
  vec3 acc = vec3( 0.0 );
  if ( near > 0.0 && near < far ) {
    float stepLength = ( far - near ) / 48.0;
    float travel = near + stepLength * hash3( vec3( gl_FragCoord.xy, aTime * 13.0 ) ) * 0.25; // de-band
    for ( int i = 0; i < 48; i++ ) {
      vec3 p = origin + dir * travel;
      acc += mix( aColorBase, aColorHigh, ( p.y - 50.0 ) / 75.0 ) * density( p ) * stepLength;
      travel += stepLength;
    }
  }
  gl_FragColor = vec4( acc * 0.05 * aGain, 1.0 );
}
`

// ---------------------------------------------------------------------------------------------------
const DEFAULTS = {
  hour: 17.2,
  sunElevation: 58,
  sunSize: 0.9,
  clouds: 0.38,
  cloudScale: 1,
  cloudSpeed: 1,
  cloudOpacity: 0.9,
  moonPhase: 11,
  moonElevation: 54,
  moonSize: 1.3,
  moonBrightness: 1,
  moonTint: [1.0, 0.87, 0.62],
  stars: 1.5,
  starDensity: 0.984,
  aurora: 0,
  auroraSpeed: 0.65,
  auroraColorBase: '#59ff03',
  auroraColorHigh: '#00aaff',
  haze: 1,
  aerialScale: 1,
  turbidity: 2.4,
  rayleigh: 1.15,
  mieCoefficient: 0.0032,
  mieG: 0.8,
  below: 'haze',
  seaLevel: 0,
  groundColor: '#6b6450',
  seed: 0,
  name: 'Sky',
}

export function createSky(options = {}) {
  const cfg = { ...DEFAULTS, ...options }
  installAerialChunks()

  // ---- LUT texture (CPU-baked, half float). Last row carries the fog's parameters.
  const lutF = new Float32Array(LUT_W * LUT_ROWS * 4)
  const lutH = new Uint16Array(LUT_W * LUT_ROWS * 4)
  const lut = new THREE.DataTexture(lutH, LUT_W, LUT_ROWS, THREE.RGBAFormat, THREE.HalfFloatType)
  lut.name = 'Sky LUT'
  lut.wrapS = THREE.RepeatWrapping
  lut.wrapT = THREE.ClampToEdgeWrapping
  lut.magFilter = lut.minFilter = THREE.LinearFilter
  lut.generateMipmaps = false
  lut.colorSpace = THREE.NoColorSpace
  provideAerialUniform(lut)

  const sunDirection = new THREE.Vector3(0, 0.3, 1).normalize()
  const moonDirection = new THREE.Vector3(0, -0.4, -1).normalize()
  const sunColor = new THREE.Color(1, 1, 1) // normalised hue of direct sunlight
  const betaR = [0, 0, 0]
  let betaM = 0

  const u = {
    uLut: { value: lut },
    uAurora: { value: null },
    uSunDir: { value: sunDirection },
    uMoonDir: { value: moonDirection },
    uSunColor: { value: new THREE.Vector3(1, 1, 1) },
    uMoonColor: { value: new THREE.Color() },
    uGroundRad: { value: new THREE.Vector3() },
    uSeed: { value: new THREE.Vector2() },
    uSunAz: { value: 0 },
    uSunCosR: { value: 0 },
    uMoonCosR: { value: 0 },
    uMoonBrightness: { value: 1 },
    uMoonLevel: { value: 0 },
    uNight: { value: 0 },
    uStarDens: { value: 0.984 },
    uStarBrightness: { value: 1.5 },
    uStarRot: { value: 0 },
    uTime: { value: 0 },
    uCloudTime: { value: 0 },
    uCloudCoverage: { value: 0.38 },
    uCloudScale: { value: 1 },
    uCloudSpeed: { value: 1 },
    uCloudOpacity: { value: 0.9 },
    uAuroraLevel: { value: 0 },
    uGain: { value: SKY_GAIN },
    uSeaLevel: { value: 0 },
  }

  const object = new THREE.Group()
  object.name = cfg.name
  const tri = new THREE.BufferGeometry()
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  tri.boundingBox = new THREE.Box3() // excluded from framing (empty box), never culled
  tri.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 0)

  const backdropMaterial = new THREE.ShaderMaterial({
    name: 'Sky backdrop', uniforms: u, vertexShader: BACKDROP_VERT, fragmentShader: BACKDROP_FRAG,
    depthWrite: false, depthTest: true, fog: false,
  })
  const backdrop = new THREE.Mesh(tri, backdropMaterial)
  backdrop.name = 'Sky backdrop'
  backdrop.frustumCulled = false
  backdrop.renderOrder = 1e9 // last of the opaque pass: early-z skips every covered pixel
  backdrop.raycast = () => {}

  // An invisible pre-pass drawn first: its material hook gets the renderer, so the GPU bakes (aurora,
  // environment PMREM), the LUT upload and the night tone toe all happen before anything is shaded.
  // (A material hook, not object.onBeforeRender, so Edit3D keeps caching shadow maps.)
  const prepassMaterial = new THREE.ShaderMaterial({
    name: 'Sky pre-pass', vertexShader: 'void main() { gl_Position = vec4( 2.0, 2.0, 2.0, 1.0 ); }',
    fragmentShader: 'void main() { gl_FragColor = vec4( 0.0 ); }', depthWrite: false, depthTest: false, colorWrite: false,
  })
  const prepass = new THREE.Mesh(tri, prepassMaterial)
  prepass.name = 'Sky pre-pass'
  prepass.frustumCulled = false
  prepass.renderOrder = -1e9
  prepass.raycast = () => {}

  // night skyglow floor (moonFill in the original); 0 by day
  const fill = new THREE.HemisphereLight(0xffffff, 0x000000, 0)
  fill.color.setRGB(0.44, 0.57, 1.0, THREE.LinearSRGBColorSpace)
  fill.name = 'Sky night fill'
  object.add(prepass, backdrop, fill)

  // ---- GPU passes (per renderer)
  const fsCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const fsGeo = new THREE.BufferGeometry()
  fsGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
  const envMaterial = new THREE.ShaderMaterial({
    name: 'Sky environment bake', uniforms: u, vertexShader: FULLSCREEN_VERT, fragmentShader: ENV_FRAG, depthTest: false, depthWrite: false,
  })
  const au = {
    aTime: { value: 0 }, aSpeed: { value: cfg.auroraSpeed }, aSeed: { value: 19.6 }, aGain: { value: 1 },
    aColorBase: { value: new THREE.Color() }, aColorHigh: { value: new THREE.Color() },
  }
  const auroraMaterial = new THREE.ShaderMaterial({
    name: 'Sky aurora bake', uniforms: au, vertexShader: FULLSCREEN_VERT, fragmentShader: AURORA_FRAG, depthTest: false, depthWrite: false,
  })
  const passMesh = new THREE.Mesh(fsGeo, envMaterial)
  passMesh.frustumCulled = false
  const passScene = new THREE.Scene()
  passScene.add(passMesh)

  const states = new Map() // renderer → its render targets and what they were baked for
  const versions = { env: 0, aurora: 0 }
  const envScenes = new WeakSet()

  function rtOpts(wrapS) {
    return { type: THREE.HalfFloatType, format: THREE.RGBAFormat, magFilter: THREE.LinearFilter, minFilter: THREE.LinearFilter,
      generateMipmaps: false, depthBuffer: false, wrapS, colorSpace: THREE.NoColorSpace }
  }
  function runPass(renderer, material, target) {
    const prevTarget = renderer.getRenderTarget(), prevXR = renderer.xr.enabled, prevAuto = renderer.autoClear
    renderer.xr.enabled = false
    renderer.autoClear = false
    passMesh.material = material
    renderer.setRenderTarget(target)
    renderer.render(passScene, fsCamera)
    renderer.setRenderTarget(prevTarget)
    renderer.xr.enabled = prevXR
    renderer.autoClear = prevAuto
  }

  const stats = { lutMs: 0, lutBakes: 0, envBakes: 0, auroraBakes: 0 }

  function prepare(renderer, scene) {
    provideAerialUniform(lut)
    renderer.toneMappingExposure = 1 - nightToe // tonemap.js reads the scotopic toe from here
    let s = states.get(renderer)
    if (!s) {
      s = { lutVersion: -1, env: -1, aurora: -1, envRT: null, auroraRT: null, pmrem: null, pmremRT: null }
      states.set(renderer, s)
    }
    if (s.lutVersion !== lut.version) { renderer.initTexture(lut); s.lutVersion = lut.version }
    if (u.uAuroraLevel.value > 0) {
      if (!s.auroraRT) s.auroraRT = new THREE.WebGLRenderTarget(AUR_W, AUR_H, rtOpts(THREE.RepeatWrapping))
      if (s.aurora !== versions.aurora) { runPass(renderer, auroraMaterial, s.auroraRT); s.aurora = versions.aurora; stats.auroraBakes++ }
      u.uAurora.value = s.auroraRT.texture
    }
    if (!envScenes.has(scene)) return
    if (!s.envRT) s.envRT = new THREE.WebGLRenderTarget(ENV_W, ENV_H, rtOpts(THREE.RepeatWrapping))
    if (s.env !== versions.env || !s.pmremRT) {
      runPass(renderer, envMaterial, s.envRT)
      if (!s.pmrem) { s.pmrem = new THREE.PMREMGenerator(renderer); s.pmremRT = s.pmrem.fromEquirectangular(s.envRT.texture) }
      else s.pmrem.fromEquirectangular(s.envRT.texture, s.pmremRT)
      s.env = versions.env
      stats.envBakes++
    }
    scene.environment = s.pmremRT.texture
    scene.environmentIntensity = sky.envIntensity
  }
  prepassMaterial.onBeforeRender = (renderer, scene) => prepare(renderer, scene)

  // ---- CPU state
  let lastBakedSunY = NaN, lastHour = NaN, lastTime = NaN, lastCloudStep = NaN, nightToe = 0, dayF = 1, moonF = 0
  const bound = { sun: null, hemi: null, targets: [], scenes: [] }
  const fog = new THREE.Fog(0xb0c4d8, -1, cfg.aerialScale)
  fog.name = 'Sky aerial perspective'

  const tmpV = new THREE.Vector3(), tmpC = new THREE.Color()
  const ambient = { sky: new THREE.Color(), ground: new THREE.Color(), intensity: PI }
  const light = { direction: new THREE.Vector3(), color: new THREE.Color(), intensity: 0, isMoon: false }

  function writeParams() {
    const o = (LUT_H + 1) * LUT_W * 4
    const ext = [0, 1, 2].map((c) => (betaR[c] * 4 + betaM * 5 * cfg.haze) * 1e4)
    const p = [
      sunDirection.x, sunDirection.y, sunDirection.z, SKY_GAIN,
      ext[0], ext[1], ext[2], 0,
      moonDirection.x, moonDirection.y, moonDirection.z, u.uMoonLevel.value * u.uNight.value,
    ]
    for (let i = 0; i < p.length; i++) lutF[o + i] = p[i]
  }
  function uploadLUT() {
    const toHalf = THREE.DataUtils.toHalfFloat
    for (let i = 0; i < lutF.length; i++) lutH[i] = toHalf(lutF[i])
    lut.needsUpdate = true
  }

  // CPU lookup of the baked sky (same mapping as the shaders), shouldered, × gain
  function lutAtCPU(d, out) {
    let a = Math.atan2(d.z, d.x) - u.uSunAz.value
    const fu = ((a / (2 * PI) + 0.5) % 1 + 1) % 1 * LUT_W - 0.5
    const el = Math.asin(Math.min(Math.max(d.y, -1), 1))
    const v = Math.sqrt(Math.min(Math.max((el - EL_MIN) / (PI / 2 - EL_MIN), 0), 1)) * (LUT_H - 1)
    const x0 = Math.floor(fu), wx = fu - x0, y0 = Math.min(Math.floor(v), LUT_H - 2), wy = v - y0
    const xa = (x0 + LUT_W) % LUT_W, xb = (x0 + 1) % LUT_W
    const r = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      const f = (x, y) => lutF[(y * LUT_W + x) * 4 + c]
      r[c] = (f(xa, y0) * (1 - wx) + f(xb, y0) * wx) * (1 - wy) + (f(xa, y0 + 1) * (1 - wx) + f(xb, y0 + 1) * wx) * wy
    }
    return out.set(r[0], r[1], r[2])
  }
  function inscatter(dir, out = new THREE.Color()) {
    const d = tmpV.copy(dir); d.y = Math.max(d.y, 0); d.normalize()
    const v = lutAtCPU(d, new THREE.Vector3())
    const cosM = d.dot(moonDirection), mn = u.uMoonLevel.value * u.uNight.value
    const k = (1 + cosM * cosM) * Math.pow(Math.max(moonDirection.y, 0), 0.4) * (smooth(-0.05, 0.22, d.y) * 0.8 + 0.2) * mn * 0.09
    v.x += 0.055 * k; v.y += 0.075 * k; v.z += 0.13 * k
    const m = Math.max(v.x, v.y, v.z), soft = Math.min(m, 0.75) + 1.65 * (1 - Math.exp(-Math.max(m - 0.75, 0) / 1.65))
    const s = soft / Math.max(m, 1e-5) * SKY_GAIN
    return out.setRGB(v.x * s, v.y * s, v.z * s, THREE.LinearSRGBColorSpace)
  }

  function syncConfig() {
    for (let c = 0; c < 3; c++) betaR[c] = BETA_R[c] * cfg.rayleigh
    betaM = cfg.mieCoefficient * cfg.turbidity * 1.95e-3
    u.uSunCosR.value = Math.cos(cfg.sunSize * PI / 180)
    u.uMoonCosR.value = Math.cos(cfg.moonSize * PI / 180)
    u.uMoonBrightness.value = cfg.moonBrightness
    u.uMoonColor.value.setRGB(...cfg.moonTint, THREE.SRGBColorSpace)
    u.uStarDens.value = cfg.starDensity
    u.uStarBrightness.value = cfg.stars
    u.uCloudCoverage.value = cfg.clouds
    u.uCloudScale.value = cfg.cloudScale
    u.uCloudSpeed.value = cfg.cloudSpeed
    u.uCloudOpacity.value = cfg.cloudOpacity
    u.uSeaLevel.value = cfg.seaLevel
    const sd = cfg.seed || 0
    u.uSeed.value.set(sd ? ((sd * 0.6180339) % 1) * 97 : 0, sd ? ((sd * 0.4142135) % 1) * 89 : 0)
    au.aSpeed.value = cfg.auroraSpeed
    au.aSeed.value = 19.6 + sd * 3.7
    au.aGain.value = Math.max(cfg.aurora, 0)
    au.aColorBase.value.set(cfg.auroraColorBase)
    au.aColorHigh.value.set(cfg.auroraColorHigh)
    fog.far = cfg.aerialScale
    const sea = cfg.below === 'sea'
    if (!!backdropMaterial.defines.SKY_SEA !== sea || !!envMaterial.defines.SKY_SEA !== sea) {
      for (const m of [backdropMaterial, envMaterial]) { if (sea) m.defines.SKY_SEA = ''; else delete m.defines.SKY_SEA; m.needsUpdate = true }
    }
    lastBakedSunY = NaN
    versions.aurora++
  }

  function setHour(hour) {
    hour = ((hour % 24) + 24) % 24
    lastHour = hour
    celestialDir(hour, cfg.sunElevation, sunDirection)
    celestialDir(hour - cfg.moonPhase, cfg.moonElevation, moonDirection)
    const tw = 9 * PI / 180, c = Math.cos(tw), s = Math.sin(tw), m = moonDirection
    m.set(m.x * c + m.z * s, m.y, m.z * c - m.x * s)
    u.uSunAz.value = Math.atan2(sunDirection.z, sunDirection.x)
    u.uStarRot.value = hour / 24 * PI * 2

    // sun-path transmittance (CPU, 24 steps) — the colour of the disc AND of the light on everything
    const dirY = sunDirection.y, dirH = Math.hypot(sunDirection.x, sunDirection.z)
    const r0y = R_PLANET + EYE_ALT, b = 2 * r0y * dirY, cc = r0y * r0y - R_ATMOS * R_ATMOS
    const tEnd = (-b + Math.sqrt(Math.max(b * b - 4 * cc, 0))) / 2, N = 24, dt = tEnd / N
    let odR = 0, odM = 0
    for (let i = 0; i < N; i++) {
      const t = (i + 0.5) * dt, py = r0y + dirY * t, px = dirH * t, h = Math.hypot(px, py) - R_PLANET
      odR += Math.exp(-h / H_R) * dt; odM += Math.exp(-h / H_M) * dt
    }
    const tr = [0, 1, 2].map((ch) => Math.exp(-(betaR[ch] * odR + betaM * odM)))
    const below = smooth(-0.02, 0.01, dirY), peak = Math.max(tr[0], 1e-6)
    sunColor.setRGB(tr[0] / peak, tr[1] / peak, tr[2] / peak, THREE.LinearSRGBColorSpace)
    const level = peak * below
    u.uSunColor.value.set(tr[0] * below, tr[1] * below, tr[2] * below)

    const illum = THREE.MathUtils.clamp((1 - sunDirection.dot(moonDirection)) * 0.5, 0, 1)
    u.uMoonLevel.value = illum * smooth(-0.02, 0.25, moonDirection.y)
    u.uNight.value = smooth(0.04, -0.14, dirY)
    dayF = smooth(-0.06, 0.18, dirY)
    moonF = smooth(0.0, 0.3, moonDirection.y) * illum
    nightToe = 1 - smooth(-0.14, -0.02, dirY)

    if (!(Math.abs(dirY - lastBakedSunY) <= 1e-6)) { // NaN (never baked / config changed) bakes
      const t0 = performance.now()
      bakeScattering(lutF, dirY, betaR, betaM, cfg.mieG)
      stats.lutMs = +(performance.now() - t0).toFixed(1)
      stats.lutBakes++
      lastBakedSunY = dirY
    }
    writeParams()
    uploadLUT()

    // the aurora arrives with the stars (nautical twilight), and is skipped — not faded — by day
    const auroraLevel = cfg.aurora > 0 ? THREE.MathUtils.clamp((-0.06 - dirY) / 0.14, 0, 1) : 0
    u.uAuroraLevel.value = auroraLevel

    // ---- the lights
    sky.sunIntensity = SUN_K * level
    const moonUp = moonF * (1 - dayF)
    const moonI = MOON_K * moonUp
    light.isMoon = moonI > sky.sunIntensity
    if (light.isMoon) {
      light.direction.copy(moonDirection); light.color.setRGB(...MOON_LIGHT, THREE.LinearSRGBColorSpace); light.intensity = moonI
    } else {
      light.direction.copy(sunDirection); light.color.copy(sunColor); light.intensity = sky.sunIntensity
    }
    fill.intensity = PI * SKY_GAIN * 0.054 * (0.4 + moonF) * (1 - dayF)
    sky.envIntensity = 1

    // ambient guidance: the original's three-tap hemisphere (zenith, glow band, counter-glow)
    const bx = sunDirection.x, bz = sunDirection.z, bl = Math.hypot(bx, bz) || 1
    const SY = 0.16, SH = Math.sqrt(1 - SY * SY), AY = 0.5, AH = Math.sqrt(1 - AY * AY)
    const zen = inscatter(new THREE.Vector3(0, 1, 0)), glow = inscatter(new THREE.Vector3(bx / bl * SH, SY, bz / bl * SH))
    const anti = inscatter(new THREE.Vector3(-bx / bl * AH, AY, -bz / bl * AH))
    ambient.sky.setRGB(zen.r * 0.42 + glow.r * 0.34 + anti.r * 0.24, zen.g * 0.42 + glow.g * 0.34 + anti.g * 0.24, zen.b * 0.42 + glow.b * 0.34 + anti.b * 0.24, THREE.LinearSRGBColorSpace)
    const albedo = tmpC.set(cfg.groundColor)
    const sunIrr = sky.sunIntensity * Math.max(dirY, 0) / PI, moonIrr = light.isMoon ? light.intensity * Math.max(moonDirection.y, 0) / PI : 0
    const fillIrr = fill.intensity / PI
    ambient.ground.setRGB(
      albedo.r * (sunIrr * sunColor.r + moonIrr * MOON_LIGHT[0] + ambient.sky.r + fillIrr * 0.44),
      albedo.g * (sunIrr * sunColor.g + moonIrr * MOON_LIGHT[1] + ambient.sky.g + fillIrr * 0.57),
      albedo.b * (sunIrr * sunColor.b + moonIrr * MOON_LIGHT[2] + ambient.sky.b + fillIrr * 1.0), THREE.LinearSRGBColorSpace)
    u.uGroundRad.value.set(ambient.ground.r, ambient.ground.g, ambient.ground.b)
    // fallback fog colour for anything the chunk patch does not reach: the mean horizon
    const h1 = inscatter(new THREE.Vector3(bx, 0, bz)), h2 = inscatter(new THREE.Vector3(-bx, 0, -bz))
    fog.color.setRGB((h1.r + h2.r) / 2, (h1.g + h2.g) / 2, (h1.b + h2.b) / 2, THREE.LinearSRGBColorSpace)

    versions.env++
    applyBound()
    return sky
  }

  function applyBound() {
    const L = bound.sun
    if (L) {
      const dist = Math.max(L.position.distanceTo(L.target.position), 1) || 50
      L.position.copy(L.target.position).addScaledVector(light.direction, dist)
      L.color.copy(light.color)
      L.intensity = light.intensity
      L.visible = true
    }
    if (bound.hemi) {
      bound.hemi.color.copy(ambient.sky); bound.hemi.groundColor.copy(ambient.ground); bound.hemi.intensity = ambient.intensity
    }
    const radiance = tmpC.copy(light.color).multiplyScalar(light.intensity)
    for (const t of bound.targets) t?.setSun?.(light.direction, radiance)
  }

  // Absolute time in seconds: cloud drift, star twinkle, aurora motion. Same time → same frame.
  function update(time) {
    if (time === lastTime) return
    lastTime = time
    u.uTime.value = time
    u.uCloudTime.value = time
    if (u.uAuroraLevel.value > 0) { au.aTime.value = time; versions.aurora++ }
    const step = Math.floor(time / 2) // the environment follows the clouds in 2 s steps
    if (step !== lastCloudStep || u.uAuroraLevel.value > 0) { lastCloudStep = step; versions.env++ }
  }

  function set(patch = {}) {
    Object.assign(cfg, patch)
    syncConfig()
    setHour('hour' in patch ? cfg.hour : (Number.isNaN(lastHour) ? cfg.hour : lastHour))
    return sky
  }

  function applyTo(scene, { sun = null, hemi = null, targets = [], background = true, environment = true, fog: useFog = true } = {}) {
    if (!object.parent) scene.add(object)
    if (background) scene.background = null
    if (environment) envScenes.add(scene)
    if (useFog) scene.fog = fog
    bound.sun = sun || bound.sun
    bound.hemi = hemi || bound.hemi
    if (targets.length) bound.targets = targets
    applyBound()
    return sky
  }

  function dispose() {
    for (const s of states.values()) { s.envRT?.dispose(); s.auroraRT?.dispose(); s.pmremRT?.dispose(); s.pmrem?.dispose() }
    states.clear()
    for (const m of [backdropMaterial, prepassMaterial, envMaterial, auroraMaterial]) m.dispose()
    tri.dispose(); fsGeo.dispose(); lut.dispose()
  }

  const sky = {
    object, backdrop, fill, fog, lut, stats, ambient, light,
    sunDirection, sunColor, moonDirection, sunIntensity: 0, envIntensity: 1,
    get hour() { return lastHour },
    get options() { return { ...cfg } },
    setHour, update, set, applyTo, inscatter, dispose,
  }
  syncConfig()
  setHour(cfg.hour)
  update(0)
  return sky
}
