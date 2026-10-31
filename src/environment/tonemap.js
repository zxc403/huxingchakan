// Filmic tone mapping for Edit3D, whose renderer runs without any (NoToneMapping): HDR skies,
// sunsets, sun glints and bright sea foam then roll off smoothly instead of clipping to flat
// white. Call once at the top of createScene, before any material compiles. It patches the
// shader chunk every built-in and onBeforeCompile material ends with, so the whole frame
// (and the exported video) shares one curve. Light the scene for it: values around 1 are
// mid-bright, not maximum, so a sun of about 3-6 and an environment intensity of 1 are normal.
//
// Night (scotopic) toe: sky.js drives it, nothing to call. sRGB's dark end is a straight line, so a
// moonlit scene rendered correctly is black; once the sun is ~1-8° down the darks are lifted by a
// power curve pivoting at 0.5 (a thousandth of daylight comes up four stops, mid-tones stay) and
// the dimmest values drain toward rod blue-grey, while anything bright (moon, stars) keeps its hue.
// The amount travels in renderer.toneMappingExposure (which three uploads to every material and
// otherwise ignores under NoToneMapping): 1 = off (the default), 0 = full toe. Only sky.js sets it.
//   enableToneMapping({ curve: 'aces' })            // 'aces' (default) | 'neutral'; exposure 1
import * as THREE from 'three'

const CURVES = {
  // ACES filmic (RRT+ODT fit): contrasty, warm highlights desaturate toward white.
  aces: /* glsl */`
    const mat3 tmIn = mat3( vec3( 0.59719, 0.07600, 0.02840 ), vec3( 0.35458, 0.90834, 0.13383 ), vec3( 0.04823, 0.01566, 0.83777 ) );
    const mat3 tmOut = mat3( vec3( 1.60475, -0.10208, -0.00327 ), vec3( -0.53108, 1.10813, -0.07276 ), vec3( -0.07367, -0.00605, 1.07602 ) );
    vec3 tmC = tmIn * ( gl_FragColor.rgb * ( TM_EXPOSURE / 0.6 ) );
    tmC = ( tmC * ( tmC + 0.0245786 ) - 0.000090537 ) / ( tmC * ( 0.983729 * tmC + 0.4329510 ) + 0.238081 );
    gl_FragColor.rgb = clamp( tmOut * tmC, 0.0, 1.0 );`,
  // Khronos PBR Neutral: leaves colours below ~0.76 almost untouched, compresses only highlights.
  neutral: /* glsl */`
    vec3 tmC = gl_FragColor.rgb * TM_EXPOSURE;
    float tmX = min( tmC.r, min( tmC.g, tmC.b ) );
    tmC -= tmX < 0.08 ? tmX - 6.25 * tmX * tmX : 0.04;
    float tmPeak = max( tmC.r, max( tmC.g, tmC.b ) );
    if ( tmPeak >= 0.76 ) {
      float tmNew = 1.0 - 0.0576 / ( tmPeak + 0.24 - 0.76 );
      tmC *= tmNew / tmPeak;
      tmC = mix( tmC, vec3( tmNew ), 1.0 - 1.0 / ( 0.15 * ( tmPeak - tmNew ) + 1.0 ) );
    }
    gl_FragColor.rgb = tmC;`,
}

// the toe of world/main.js: pow(c, 0.8) pivoting at 0.5, then a level-dependent drain to rod blue
const NIGHT_TOE = /* glsl */`
  #ifdef TM_NIGHT_UNIFORM
    float tmNight = clamp( 1.0 - toneMappingExposure, 0.0, 1.0 );
    if ( tmNight > 0.0 ) {
      vec3 tmN = mix( gl_FragColor.rgb, pow( max( gl_FragColor.rgb, vec3( 1e-5 ) ), vec3( 0.8 ) ) * 0.870551, tmNight );
      float tmLum = dot( tmN, vec3( 0.2126, 0.7152, 0.0722 ) );
      gl_FragColor.rgb = mix( tmN, tmLum * vec3( 0.74, 0.92, 1.32 ), tmNight * smoothstep( 0.26, 0.015, tmLum ) * 0.62 );
    }
  #endif`

// colorspace_pars_fragment sits in the prefix of every non-raw fragment shader, at global scope
const COLORSPACE_PARS = THREE.ShaderChunk.colorspace_pars_fragment
const NIGHT_UNIFORM = '\n#ifndef TONE_MAPPING\nuniform float toneMappingExposure;\n#endif\n#define TM_NIGHT_UNIFORM\n'

export function enableToneMapping({ curve = 'aces', exposure = 1 } = {}) {
  const body = CURVES[curve]
  if (!body) throw new Error(`enableToneMapping: unknown curve "${curve}" (aces | neutral)`)
  if (!THREE.ShaderChunk.colorspace_pars_fragment.includes('TM_NIGHT_UNIFORM'))
    THREE.ShaderChunk.colorspace_pars_fragment = COLORSPACE_PARS + NIGHT_UNIFORM
  THREE.ShaderChunk.tonemapping_fragment = `{\n#define TM_EXPOSURE ${exposure.toFixed(4)}\n${NIGHT_TOE}\n${body}\n#undef TM_EXPOSURE\n}`
}
