export const auroraVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

export const auroraFragment = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec2 uPointer;
  uniform vec2 uResolution;
  uniform vec3 uGold;
  uniform vec3 uEmber;
  uniform vec3 uInk;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }

  float fbm(vec2 p) {
    float value = 0.0;
    float amplitude = 0.5;
    for (int i = 0; i < 5; i++) {
      value += amplitude * noise(p);
      p *= 2.02;
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 uv = vUv;
    float aspect = uResolution.x / max(uResolution.y, 1.0);
    vec2 p = (uv - 0.5) * vec2(aspect, 1.0);
    float t = uTime * 0.045;

    vec2 q = p * 1.7;
    float warp = fbm(q + vec2(t, -t));
    float n = fbm(q + warp * 1.8 + vec2(-t * 0.7, t * 0.5));
    float ridge = smoothstep(0.34, 0.86, n);

    vec3 col = mix(uInk, uEmber * 0.42, ridge * 0.52);
    col = mix(col, uGold * 0.92, pow(ridge, 2.3) * 0.68);
    col += vec3(0.09, 0.18, 0.24) * pow(ridge, 3.8);

    vec2 pointer = (uPointer - 0.5) * vec2(aspect, 1.0);
    float glow = exp(-length(p - pointer) * 3.1);
    col += uGold * glow * 0.42;
    col += uEmber * glow * 0.16;

    float vignette = smoothstep(1.18, 0.22, length(p * vec2(0.86, 1.0)));
    col *= mix(0.52, 1.06, vignette);
    col += (hash(uv * uResolution + uTime) - 0.5) * 0.032;

    gl_FragColor = vec4(col, 1.0);
  }
`;

export const ringVertex = /* glsl */ `
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec2 vUv;
  void main() {
    vUv = uv;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    vNormal = normalize(normalMatrix * normal);
    vView = normalize(-mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

export const ringFragment = /* glsl */ `
  precision highp float;
  uniform float uTime;
  uniform vec3 uGold;
  uniform vec3 uEmber;
  uniform vec3 uCool;
  varying vec3 vNormal;
  varying vec3 vView;
  varying vec2 vUv;

  void main() {
    float fresnel = pow(1.0 - clamp(dot(normalize(vNormal), normalize(vView)), 0.0, 1.0), 2.2);
    float band = sin(vUv.x * 18.8496 + uTime * 0.65) * 0.5 + 0.5;
    vec3 col = mix(uGold * 0.82, uEmber * 0.82, band);
    col = mix(col, uCool, fresnel * 0.24);
    col += fresnel * 0.58;
    gl_FragColor = vec4(col, 0.16 + fresnel * 0.58);
  }
`;
