import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildSolarSystem, PLANET_FACTS, AU_IN_PC } from './solarsystem.js';
import {
  loadGalaxies,
  buildGalaxyPoints,
  buildGalaxyPickMaterial,
  buildResolvedGalaxies,
  ttypeLabel,
  MPC_IN_PC,
} from './galaxies.js';

// ---------------------------------------------------------------------------
// Floating origin
//
// Star positions run to thousands of parsecs. Float32 (what the GPU uses) has
// ~7 significant digits, so a camera sitting at 5000 pc while resolving detail
// at 0.001 pc has already run out of precision -- geometry visibly jitters.
//
// The fix: the camera never leaves the region near (0,0,0). Instead we hold the
// true camera position in float64 on the CPU, and whenever it drifts past
// REBASE_DISTANCE we subtract the new origin out of every vertex. The GPU only
// ever sees small numbers.
// ---------------------------------------------------------------------------

const REBASE_DISTANCE = 200; // parsecs of drift before we re-center

// The Sun sits ~8178 pc from the galactic center (GRAVITY collaboration, 2019).
// Gaia coordinates are Sun-centered; the procedural galaxy is center-centered.
// Everything in this viewer uses the galactic frame, so Gaia stars get shifted
// out to the Sun's actual position rather than sitting at the origin.
const SUN_GALACTIC_X = -8178.0;

const worldOrigin = new THREE.Vector3(); // float64 on the CPU side
const lastRebaseAt = new THREE.Vector3(); // camera pos at the last rebase
let basePositions = null;                // pristine absolute positions
let starPoints = null;
let catalogCount = 0;
let proceduralCount = 0;
let starData = null;                     // v2 catalog fields, for the info panel
let starMagnitudes = null;
let starCount = 0;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  0.01,
  1e7,
);
// Start at galactic scale, well above the plane so the spiral arms are visible
// rather than edge-on.
camera.position.set(0, -16000, 20000);
lastRebaseAt.copy(camera.position);

const renderer = new THREE.WebGLRenderer({
  antialias: true,
  logarithmicDepthBuffer: true, // survives the huge near/far spread
});
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

// ---------------------------------------------------------------------------
// Tier system
//
// The intergalactic tier works in megaparsecs, the stellar tier in parsecs -- a
// factor of a million. One shared coordinate frame cannot hold both without
// float32 falling apart, so each tier gets its own scene and camera, drawn in
// sequence with a cross-fade.
//
// The cameras stay locked together: one set of OrbitControls drives the stellar
// camera, and the galactic camera mirrors it scaled down by a million. So a
// single continuous scroll carries you from a planet out past Virgo.
// ---------------------------------------------------------------------------

// Camera distance (pc from the Milky Way centre) where the cross-fade runs.
const TIER_FADE_START = 60000;   // galaxies begin to appear
const TIER_FADE_END = 400000;    // stars fully gone, galaxies fully present

const galaxyScene = new THREE.Scene();
const galaxyCamera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / window.innerHeight,
  1e-5,
  1e5,
);

// Named "cluster*" to keep them distinct from the procedural Milky Way backdrop
// further down, which is a different thing entirely.
let clusterData = null;
let clusterPoints = null;
let clusterMaterial = null;
let clusterPickMaterial = null;
let clusterCount = 0;
let resolvedGroup = null;
let resolvedEntries = [];

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
// Must reach from galactic scale down to inside the solar system.
controls.minDistance = 1e-8;
// Must reach past Virgo (~25 Mpc = 2.5e7 pc) for the intergalactic tier.
controls.maxDistance = 4e7;
// Zoom in fixed proportion, so travelling 10 orders of magnitude takes a
// sensible number of scroll clicks instead of thousands.
controls.zoomSpeed = 1.6;

// ---------------------------------------------------------------------------
// Shader: size by brightness and distance, soft round falloff.
// ---------------------------------------------------------------------------

const starMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPixelRatio: { value: renderer.getPixelRatio() },
    uSizeScale: { value: 2600.0 },
    uCatalogFade: { value: 1.0 },
    uTierFade: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 starColor;
    attribute float magnitude;

    uniform float uPixelRatio;
    uniform float uSizeScale;

    varying vec3 vColor;
    varying float vBrightness;

    void main() {
      vColor = starColor;

      // Magnitude is logarithmic and inverted: lower = brighter.
      // The real catalog runs to G=13, so normalise against that rather than 12.
      float brightness = clamp((11.0 - magnitude) / 11.0, 0.05, 1.0);
      vBrightness = brightness;

      vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewPos;

      // Attenuate with distance, but keep a floor so distant stars stay visible
      // as pinpricks rather than vanishing entirely.
      float dist = max(length(viewPos.xyz), 0.001);
      gl_PointSize = max(
        brightness * uSizeScale * uPixelRatio / dist,
        0.6 * uPixelRatio
      );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uCatalogFade;
    uniform float uTierFade;

    varying vec3 vColor;
    varying float vBrightness;

    void main() {
      // Round the square point sprite and give it a soft core.
      vec2 d = gl_PointCoord - vec2(0.5);
      float r = length(d) * 2.0;
      if (r > 1.0) discard;

      float alpha = pow(1.0 - r, 1.8) * uCatalogFade * uTierFade;
      gl_FragColor = vec4(vColor * (0.4 + vBrightness), alpha);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

// ---------------------------------------------------------------------------
// GPU picking
//
// Raycasting a million-point cloud means a million CPU-side distance tests per
// click. Instead we re-render the points into a 1x1 target with each star's
// index encoded as RGBA, then read back that single pixel. The cost does not
// depend on how many stars there are.
//
// The pick pass must mirror the visual shader's gl_PointSize, or you would be
// able to see a star you cannot click. It only differs in enforcing a larger
// minimum, so faint one-pixel stars stay reachable by an imprecise mouse.
// ---------------------------------------------------------------------------

const PICK_MIN_SIZE = 6.0; // px of click tolerance for the faintest stars

const pickTarget = new THREE.WebGLRenderTarget(1, 1, {
  format: THREE.RGBAFormat,
  type: THREE.UnsignedByteType,
});
const pickPixel = new Uint8Array(4);

const pickMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPixelRatio: { value: renderer.getPixelRatio() },
    uSizeScale: { value: 2600.0 },
  },
  vertexShader: /* glsl */ `
    attribute float magnitude;
    attribute float starIndex;

    uniform float uPixelRatio;
    uniform float uSizeScale;

    varying vec4 vId;

    void main() {
      // Encode the index into RGBA bytes, low byte first.
      float id = starIndex + 1.0; // 0 is reserved for "nothing here"
      vId = vec4(
        mod(id, 256.0),
        mod(floor(id / 256.0), 256.0),
        mod(floor(id / 65536.0), 256.0),
        floor(id / 16777216.0)
      ) / 255.0;

      // Must match the visual shader's formula exactly, or stars are visible
      // but not clickable (or vice versa).
      float brightness = clamp((11.0 - magnitude) / 11.0, 0.05, 1.0);

      vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewPos;

      float dist = max(length(viewPos.xyz), 0.001);
      gl_PointSize = max(
        brightness * uSizeScale * uPixelRatio / dist,
        ${PICK_MIN_SIZE.toFixed(1)} * uPixelRatio
      );
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec4 vId;

    void main() {
      // Round mask matching the visual sprite, so the clickable area is the
      // disc the user actually sees rather than its bounding square.
      vec2 d = gl_PointCoord - vec2(0.5);
      if (length(d) * 2.0 > 1.0) discard;
      gl_FragColor = vId;
    }
  `,
  // Nearest star must win. Additive blending and depthWrite:false are right for
  // the visual pass but would corrupt an id buffer.
  transparent: false,
  depthWrite: true,
  depthTest: true,
  blending: THREE.NoBlending,
});

// Returns a star index, or -1 for empty sky.
function pickAt(clientX, clientY) {
  if (!starPoints) return -1;

  const rect = renderer.domElement.getBoundingClientRect();
  const dpr = renderer.getPixelRatio();
  const x = (clientX - rect.left) * dpr;
  const y = (rect.height - (clientY - rect.top)) * dpr; // GL origin is bottom-left

  const width = rect.width * dpr;
  const height = rect.height * dpr;

  // setViewOffset makes the camera render only the one pixel under the cursor
  // into the 1x1 target, instead of drawing a full frame and cropping it.
  camera.setViewOffset(width, height, x, y, 1, 1);

  starPoints.material = pickMaterial;

  // Anything else in the scene writes its own colors into the id buffer and
  // decodes as a bogus index. The procedural galaxy is the dangerous one: it is
  // not a real catalog, so a "hit" on it must never resolve to a star at all.
  const hiddenForPick = [marker, hoverMarker, sunBeacon, solarGroup, galaxyPoints];
  const wasVisible = hiddenForPick.map((o) => o && o.visible);
  for (const o of hiddenForPick) if (o) o.visible = false;

  // Clear to all-zero explicitly. The default clear alpha is 1, which decodes
  // as 255*16777216 -- a huge nonzero id for what is actually empty sky.
  const prevClearColor = renderer.getClearColor(new THREE.Color());
  const prevClearAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);

  renderer.setRenderTarget(pickTarget);
  renderer.clear();
  renderer.render(scene, camera);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickPixel);

  renderer.setRenderTarget(null);
  renderer.setClearColor(prevClearColor, prevClearAlpha);
  starPoints.material = starMaterial;
  hiddenForPick.forEach((o, i) => {
    if (o) o.visible = wasVisible[i];
  });
  camera.clearViewOffset();

  const id =
    pickPixel[0] +
    pickPixel[1] * 256 +
    pickPixel[2] * 65536 +
    pickPixel[3] * 16777216;

  if (id === 0) return -1;

  // Guard against anything that slipped into the id buffer and decoded to a
  // number outside the catalog. Better to report empty sky than to index past
  // the end of the arrays and show invented values as if they were real.
  const index = id - 1;
  return index < starCount ? index : -1;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadStars(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'STAR') throw new Error('Not a starmap binary (bad magic).');

  const [version, count] = new Uint32Array(buf, 4, 3);

  let offset = 16;
  const positions = new Float32Array(buf, offset, count * 3);
  offset += count * 12;
  const colorBytes = new Uint8Array(buf, offset, count * 3);
  offset += count * 3;
  const magnitudes = new Float32Array(buf.slice(offset, offset + count * 4));
  offset += count * 4;

  // v2 adds the per-star catalog fields the info panel needs. v1 files still
  // load; they just show position-derived values only.
  if (version >= 2) {
    starData = {
      sourceIds: new Uint32Array(buf.slice(offset, offset + count * 8)),
      bpRp: new Float32Array(buf.slice(offset + count * 8, offset + count * 12)),
      parallax: new Float32Array(buf.slice(offset + count * 12, offset + count * 16)),
    };
  }

  // Keep an untouched copy; every rebase recomputes from these, so rounding
  // error can't accumulate across thousands of re-centerings.
  // Shift Sun-centered Gaia coordinates into the galactic frame.
  basePositions = new Float32Array(positions);
  for (let i = 0; i < basePositions.length; i += 3) {
    basePositions[i] += SUN_GALACTIC_X;
  }
  starMagnitudes = magnitudes;
  starCount = count;

  const geometry = new THREE.BufferGeometry();
  // Shares basePositions directly -- nothing mutates it now that rebasing moves
  // the object instead of rewriting vertices.
  geometry.setAttribute('position', new THREE.BufferAttribute(basePositions, 3));
  geometry.setAttribute('starColor', new THREE.BufferAttribute(colorBytes, 3, true));
  geometry.setAttribute('magnitude', new THREE.BufferAttribute(magnitudes, 1));

  // Each star carries its own index so the pick shader can encode it into RGBA.
  const indices = new Float32Array(count);
  for (let i = 0; i < count; i++) indices[i] = i;
  geometry.setAttribute('starIndex', new THREE.BufferAttribute(indices, 1));

  // A bounding sphere from absolute coords would be wrong after rebasing, and
  // frustum culling would pop the whole cloud out of view.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  starPoints = new THREE.Points(geometry, starMaterial);
  starPoints.frustumCulled = false;
  scene.add(starPoints);

  catalogCount = count;
  updateStatus();
}

// ---------------------------------------------------------------------------
// Procedural galaxy backdrop
//
// These stars are invented -- sampled from the standard density model, not
// measured. They exist so the galaxy looks like a galaxy at large zoom instead
// of a lopsided blob around the Sun. They are deliberately dimmer than the Gaia
// stars, kept out of the pick pass, and can never open an info panel.
// ---------------------------------------------------------------------------

let galaxyPoints = null;

const galaxyMaterial = new THREE.ShaderMaterial({
  uniforms: {
    uPixelRatio: { value: renderer.getPixelRatio() },
    uSizeScale: { value: 2600.0 },
    uTierFade: { value: 1.0 },
  },
  vertexShader: /* glsl */ `
    attribute vec3 starColor;
    attribute float magnitude;

    uniform float uPixelRatio;
    uniform float uSizeScale;

    varying vec3 vColor;
    varying float vBrightness;

    void main() {
      vColor = starColor;
      float brightness = clamp((14.0 - magnitude) / 14.0, 0.05, 1.0);
      vBrightness = brightness;

      vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
      gl_Position = projectionMatrix * viewPos;

      float dist = max(length(viewPos.xyz), 0.001);
      gl_PointSize = max(
        brightness * uSizeScale * uPixelRatio / dist,
        0.5 * uPixelRatio
      );
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uTierFade;

    varying vec3 vColor;
    varying float vBrightness;

    void main() {
      vec2 d = gl_PointCoord - vec2(0.5);
      float r = length(d) * 2.0;
      if (r > 1.0) discard;

      // Dimmer than the real stars, so the catalogued bubble reads as denser
      // and brighter than the invented backdrop. Kept low because additive
      // blending saturates to flat white wherever the bulge is dense.
      float alpha = pow(1.0 - r, 2.0) * 0.22 * uTierFade;
      gl_FragColor = vec4(vColor * (0.3 + vBrightness * 0.7), alpha);
    }
  `,
  transparent: true,
  depthWrite: false,
  blending: THREE.AdditiveBlending,
});

async function loadGalaxy(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'GALX') throw new Error('Not a galaxy binary (bad magic).');

  const [, count] = new Uint32Array(buf, 4, 3);

  let offset = 16;
  const positions = new Float32Array(buf.slice(offset, offset + count * 12));
  offset += count * 12;
  const colorBytes = new Uint8Array(buf.slice(offset, offset + count * 3));
  offset += count * 3;
  const magnitudes = new Float32Array(buf.slice(offset, offset + count * 4));

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('starColor', new THREE.BufferAttribute(colorBytes, 3, true));
  geometry.setAttribute('magnitude', new THREE.BufferAttribute(magnitudes, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  galaxyPoints = new THREE.Points(geometry, galaxyMaterial);
  galaxyPoints.frustumCulled = false;
  // Draw behind the real stars.
  galaxyPoints.renderOrder = -1;
  scene.add(galaxyPoints);

  return count;
}

// Re-express every star relative to the new origin.
//
// The vertex buffers are never touched. Rewriting 2.4M positions on the CPU and
// re-uploading ~29MB per rebase caused a visible hitch every time the camera
// drifted. Instead the geometry keeps its original absolute coordinates and the
// object is offset, which Three.js folds into the model matrix on the GPU.
//
// Precision is preserved because the subtraction still happens in float32 in the
// shader (modelViewMatrix concatenates the offset with the view matrix before
// the vertex is transformed), and the offset itself is tracked in float64 here.
function rebase(newOrigin) {
  worldOrigin.copy(newOrigin);

  const offset = newOrigin.clone().negate();
  starPoints.position.copy(offset);
  if (galaxyPoints) galaxyPoints.position.copy(offset);
}

// ---------------------------------------------------------------------------
// Selection + info panel
// ---------------------------------------------------------------------------

let selectedIndex = -1;
const panel = document.getElementById('info');

// Ring drawn around the selected star. Sized in screen space so it stays
// visible whatever the zoom level.
const marker = new THREE.Sprite(
  new THREE.SpriteMaterial({
    color: 0x66ccff,
    transparent: true,
    opacity: 0.9,
    depthTest: false,
    map: (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(32, 32, 24, 0, Math.PI * 2);
      ctx.stroke();
      return new THREE.CanvasTexture(c);
    })(),
  }),
);
marker.visible = false;
marker.renderOrder = 999;
scene.add(marker);

// Rough spectral class from BP-RP color index. Boundaries are approximate;
// good enough to label a star, not to do science with.
function spectralClass(bpRp) {
  if (bpRp < 0.0) return 'B (blue, very hot)';
  if (bpRp < 0.33) return 'A (blue-white)';
  if (bpRp < 0.59) return 'F (white)';
  if (bpRp < 0.82) return 'G (yellow, Sun-like)';
  if (bpRp < 1.41) return 'K (orange)';
  return 'M (red dwarf / giant)';
}

function readSourceId(index) {
  const lo = BigInt(starData.sourceIds[index * 2]);
  const hi = BigInt(starData.sourceIds[index * 2 + 1]);
  return ((hi << 32n) | lo).toString();
}

function showStar(index) {
  selectedIndex = index;

  if (index < 0) {
    panel.hidden = true;
    marker.visible = false;
    return;
  }
  marker.visible = true;

  // Absolute coordinates, not the rebased attribute -- the rebased values are
  // relative to wherever the camera last re-centered.
  const x = basePositions[index * 3];
  const y = basePositions[index * 3 + 1];
  const z = basePositions[index * 3 + 2];

  // These are galactic-frame coords, so distance from Earth means distance from
  // the Sun's position, not from the origin (which is the galactic center).
  const dx = x - SUN_GALACTIC_X;
  const distPc = Math.sqrt(dx * dx + y * y + z * z);
  const distFromCenter = Math.sqrt(x * x + y * y + z * z);

  const mag = starMagnitudes[index];

  // Absolute magnitude: brightness at a standard 10 pc.
  const absMag = distPc > 0 ? mag - 5 * Math.log10(distPc / 10) : NaN;

  const rows = [
    ['From Earth', `${distPc.toFixed(1)} pc  (${(distPc * 3.26156).toFixed(1)} ly)`],
    ['From gal. center', `${(distFromCenter / 1000).toFixed(2)} kpc`],
    ['Apparent mag', mag.toFixed(2)],
    ['Absolute mag', Number.isFinite(absMag) ? absMag.toFixed(2) : '—'],
  ];

  if (starData) {
    rows.push(['Color (BP−RP)', starData.bpRp[index].toFixed(3)]);
    rows.push(['Spectral class', spectralClass(starData.bpRp[index])]);
    rows.push(['Parallax', `${starData.parallax[index].toFixed(3)} mas`]);
  }

  const title = starData ? `Gaia DR3 ${readSourceId(index)}` : `Star #${index}`;

  panel.innerHTML =
    `<h2>${title}</h2>` +
    rows
      .map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`)
      .join('') +
    `<button id="close">close</button>`;
  panel.hidden = false;

  document.getElementById('close').addEventListener('click', () => showStar(-1));
}

// Distinguish a click from the end of an orbit drag.
let pointerDownAt = null;

const raycaster = new THREE.Raycaster();
const pointerNdc = new THREE.Vector2();

// Info panel for a solar system body.
function showBody(body) {
  if (!body) return;
  selectedIndex = -1;
  marker.visible = false;

  const facts = PLANET_FACTS[body.name];
  const rows = [];

  if (body.au > 0) {
    rows.push(['Distance from Sun', `${body.au} AU`]);
    rows.push(['Light travel time', `${(body.au * 8.317).toFixed(1)} min`]);
  }
  if (facts) {
    rows.push(['Day length', facts.day]);
    rows.push(['Year length', facts.year]);
    rows.push(['Moons', String(facts.moons)]);
    rows.push(['Temperature', facts.temp]);
  }
  if (body.name === 'Sun') {
    rows.push(['Type', 'G2V main sequence']);
    rows.push(['Surface temp', '5,772 K']);
    rows.push(['From gal. center', '8.18 kpc']);
  }

  panel.innerHTML =
    `<h2>${body.name}</h2>` +
    rows
      .map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`)
      .join('') +
    `<button id="close">close</button>`;
  panel.hidden = false;
  document.getElementById('close').addEventListener('click', () => {
    panel.hidden = true;
  });
}

// Hover highlight.
//
// readRenderTargetPixels stalls the GPU pipeline waiting for the result, so
// picking on every pointermove would tank the framerate. Instead we record the
// latest cursor position and pick at most once per frame, in the render loop.
let hoverAt = null;      // {x, y} pending pick, or null
let hoveredIndex = -1;

const hoverMarker = marker.clone();
hoverMarker.material = marker.material.clone();
hoverMarker.material.color.set(0xffffff);
hoverMarker.material.opacity = 0.35;
hoverMarker.visible = false;
scene.add(hoverMarker);

renderer.domElement.addEventListener('pointermove', (e) => {
  hoverAt = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerleave', () => {
  hoverAt = null;
  hoveredIndex = -1;
  hoverMarker.visible = false;
  renderer.domElement.style.cursor = 'default';
});

// Runs once per frame from animate(), never per event.
function updateHover() {
  if (!hoverAt || !starPoints) return;

  // Skip while orbiting -- the pick would be stale by the time it lands, and
  // dragging is when the framerate matters most.
  if (pointerDownAt) return;

  const index = pickAt(hoverAt.x, hoverAt.y);
  hoverAt = null;

  if (index === hoveredIndex) return;
  hoveredIndex = index;

  hoverMarker.visible = index >= 0 && index !== selectedIndex;
  renderer.domElement.style.cursor = index >= 0 ? 'pointer' : 'default';
}

renderer.domElement.addEventListener('pointerdown', (e) => {
  pointerDownAt = { x: e.clientX, y: e.clientY };
});

renderer.domElement.addEventListener('pointerup', (e) => {
  if (!pointerDownAt) return;
  const moved = Math.hypot(e.clientX - pointerDownAt.x, e.clientY - pointerDownAt.y);
  pointerDownAt = null;
  if (moved > 4) return; // that was a drag, not a click

  // Planets first: only 9 objects, so a raycast is the right tool here. They
  // also sit in front of the stars whenever they are visible at all.
  if (solarGroup.visible) {
    const rect = renderer.domElement.getBoundingClientRect();
    pointerNdc.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointerNdc, camera);
    const hit = raycaster.intersectObjects(solarBodies.map((b) => b.mesh))[0];
    if (hit) {
      showBody(solarBodies.find((b) => b.mesh === hit.object));
      return;
    }
  }

  // Try the galaxy tier whenever galaxies are drawn at all, not only past the
  // midpoint of the fade. Mid-blend the screen is visibly full of galaxies, so
  // requiring >0.5 made them unclickable exactly where they look clickable.
  // Falls through to the star tier when nothing is hit.
  if (clusterPoints && tierBlend() > 0.02) {
    // Resolved discs are drawn as sprites, not points, so the point-cloud pick
    // misses them entirely -- their visible area is many times the dot's. Test
    // those by screen distance first.
    const gi = pickResolvedGalaxyAt(e.clientX, e.clientY);
    if (gi >= 0) {
      showGalaxy(gi);
      return;
    }
    const gp = pickGalaxyAt(e.clientX, e.clientY);
    if (gp >= 0) {
      showGalaxy(gp);
      return;
    }
  }

  showStar(pickAt(e.clientX, e.clientY));
});

// Hit-test the resolved galaxy sprites by projecting each to screen space.
// There are only ~60 of them, so this is cheap, and unlike the point-cloud pick
// it uses the sprite's real on-screen radius.
function pickResolvedGalaxyAt(clientX, clientY) {
  if (!resolvedEntries.length) return -1;

  // Same reason pickGalaxyAt syncs the camera: a click must not depend on the
  // frame loop having already run this frame.
  syncGalaxyCamera();
  updateResolvedGalaxies(tierBlend());

  const rect = renderer.domElement.getBoundingClientRect();
  const px = clientX - rect.left;
  const py = clientY - rect.top;

  let best = -1;
  let bestDist = Infinity;

  for (const entry of resolvedEntries) {
    if (!entry.sprite.visible) continue;

    const p = entry.sprite.position.clone().project(galaxyCamera);
    if (p.z < -1 || p.z > 1) continue;

    const sx = (p.x * 0.5 + 0.5) * rect.width;
    const sy = (-p.y * 0.5 + 0.5) * rect.height;

    // On-screen radius from the same projection the fade uses.
    const camDist = entry.sprite.position.distanceTo(galaxyCamera.position);
    const projScale =
      rect.height /
      (2 * Math.tan(THREE.MathUtils.degToRad(galaxyCamera.fov) / 2));
    const radius = ((entry.diameter / Math.max(camDist, 1e-9)) * projScale) / 2;

    const d = Math.hypot(px - sx, py - sy);
    // Only the inner part of the sprite is bright enough to read as the galaxy.
    if (d < radius * 0.65 && d < bestDist) {
      bestDist = d;
      best = entry.index;
    }
  }

  return best;
}

// Same 1x1 readback trick as the stellar tier, against the galaxy scene.
function pickGalaxyAt(clientX, clientY) {
  if (!clusterPoints) return -1;

  // Sync the galaxy camera here rather than relying on updateTiers having run
  // this frame. A pick must not depend on frame-loop ordering.
  syncGalaxyCamera();

  const rect = renderer.domElement.getBoundingClientRect();
  const dpr = renderer.getPixelRatio();
  const x = (clientX - rect.left) * dpr;
  const y = (rect.height - (clientY - rect.top)) * dpr;
  const width = rect.width * dpr;
  const height = rect.height * dpr;

  galaxyCamera.setViewOffset(width, height, x, y, 1, 1);
  clusterPoints.material = clusterPickMaterial;
  // Must be drawn for the pick render even if the fade has it hidden right now.
  const wasVisible = clusterPoints.visible;
  clusterPoints.visible = true;

  const prevColor = renderer.getClearColor(new THREE.Color());
  const prevAlpha = renderer.getClearAlpha();
  renderer.setClearColor(0x000000, 0);

  renderer.setRenderTarget(pickTarget);
  renderer.clear();
  renderer.render(galaxyScene, galaxyCamera);
  renderer.readRenderTargetPixels(pickTarget, 0, 0, 1, 1, pickPixel);

  renderer.setRenderTarget(null);
  renderer.setClearColor(prevColor, prevAlpha);
  clusterPoints.material = clusterMaterial;
  clusterPoints.visible = wasVisible;
  galaxyCamera.clearViewOffset();

  const id =
    pickPixel[0] +
    pickPixel[1] * 256 +
    pickPixel[2] * 65536 +
    pickPixel[3] * 16777216;

  if (id === 0) return -1;
  const index = id - 1;
  return index < clusterCount ? index : -1;
}

function showGalaxy(index) {
  selectedIndex = -1;
  marker.visible = false;

  const d = clusterData;
  const dist = d.dists[index];
  const bmag = d.bmags[index];
  const tt = d.ttypes[index];

  const rows = [
    ['Distance', `${dist.toFixed(2)} Mpc  (${(dist * 3.26156).toFixed(2)} Mly)`],
    ['Type', ttypeLabel(tt)],
  ];
  if (!Number.isNaN(bmag)) rows.push(['B magnitude', bmag.toFixed(2)]);
  if (!Number.isNaN(tt)) rows.push(['T-type', tt.toFixed(1)]);

  // Light travel time is the intuitive one at this scale: you are seeing this
  // galaxy as it was that long ago.
  rows.push(['Light left', `${(dist * 3.26156).toFixed(2)} million years ago`]);

  panel.innerHTML =
    `<h2>${d.nameAt(index)}</h2>` +
    rows
      .map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`)
      .join('') +
    `<button id="close">close</button>`;
  panel.hidden = false;
  document.getElementById('close').addEventListener('click', () => {
    panel.hidden = true;
  });
}

// ---------------------------------------------------------------------------
// Solar system
//
// Built in absolute galactic coords at the Sun's position, then shifted on each
// rebase like everything else. Only shown when the camera is close enough for it
// to be more than a sub-pixel speck -- at galactic zoom it is invisible anyway,
// and drawing it wastes the depth range.
// ---------------------------------------------------------------------------

const SOLAR_VISIBLE_WITHIN = 0.05; // pc from the Sun

const sunAbsolute = new THREE.Vector3(SUN_GALACTIC_X, 0, 0);
const { group: solarGroup, bodies: solarBodies } = buildSolarSystem(sunAbsolute);
solarGroup.visible = false;
scene.add(solarGroup);

// Marks the Sun at scales where the solar system itself is too small to see.
const sunBeacon = new THREE.Sprite(
  new THREE.SpriteMaterial({
    color: 0xffd88a,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    map: (() => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, 'rgba(255,255,255,1)');
      g.addColorStop(0.3, 'rgba(255,216,138,0.9)');
      g.addColorStop(1, 'rgba(255,216,138,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
      return new THREE.CanvasTexture(c);
    })(),
  }),
);
sunBeacon.renderOrder = 998;
scene.add(sunBeacon);

function updateSolarSystem() {
  // Sun position in the current rebased frame.
  const sunNow = sunAbsolute.clone().sub(worldOrigin);
  solarGroup.position.copy(sunNow);
  sunBeacon.position.copy(sunNow);

  const camDist = camera.position.distanceTo(sunNow);
  solarGroup.visible = camDist < SOLAR_VISIBLE_WITHIN;

  // The beacon fades out as the real solar system fades in, so there is never
  // both a glow sprite and a rendered Sun sitting on top of each other.
  sunBeacon.visible = !solarGroup.visible;
  // Small and constant on screen. Scaling by raw distance makes it a huge blob
  // at galactic zoom, which reads as an object rather than a marker.
  sunBeacon.scale.setScalar(camDist * 0.0012);
}

// ---------------------------------------------------------------------------
// Tier cross-fade
// ---------------------------------------------------------------------------

// How zoomed out we are: distance from the camera to what it is orbiting.
//
// This is deliberately NOT distance from the galactic centre or from the Sun.
// Those confuse "zoomed far out" with "flew somewhere far away" -- parking at
// the galactic centre at close zoom would trigger an intergalactic fade and
// dim every nearby star, which is what turned the view black at 8.18 kpc.
function zoomLevel() {
  return camera.position.distanceTo(controls.target);
}

// 0 = purely stellar tier, 1 = purely intergalactic.
function tierBlend() {
  return THREE.MathUtils.clamp(
    (zoomLevel() - TIER_FADE_START) / (TIER_FADE_END - TIER_FADE_START),
    0,
    1,
  );
}

// Mirror the stellar camera into megaparsec space. The Milky Way sits at the
// origin of the galaxy catalog, and the stellar frame's origin is the galactic
// centre too, so this is a straight unit conversion.
function syncGalaxyCamera() {
  if (!clusterPoints) return;

  const absCam = worldOrigin.clone().add(camera.position);
  galaxyCamera.position.copy(absCam).divideScalar(MPC_IN_PC);

  const absTarget = worldOrigin.clone().add(controls.target);
  galaxyCamera.up.copy(camera.up);
  galaxyCamera.lookAt(absTarget.divideScalar(MPC_IN_PC));

  // Near/far have to track the camera here too, for the same reason as the
  // stellar tier: the usable range spans many orders of magnitude.
  const camDist = Math.max(galaxyCamera.position.length(), 1e-5);
  galaxyCamera.near = camDist * 1e-4;
  galaxyCamera.far = Math.max(camDist * 100, 1e3);
  galaxyCamera.updateProjectionMatrix();

  const size = Math.max(camDist * 12.0, 6.0);
  clusterMaterial.uniforms.uSizeScale.value = size;
  clusterPickMaterial.uniforms.uSizeScale.value = size;
}

function updateTiers() {
  const blend = tierBlend();

  // Stellar tier fades out as we pull away from the Milky Way.
  const stellarAlpha = 1 - blend;
  scene.visible = stellarAlpha > 0.001;
  if (starMaterial.uniforms.uTierFade) {
    starMaterial.uniforms.uTierFade.value = stellarAlpha;
  }
  galaxyMaterial.uniforms.uTierFade.value = stellarAlpha;

  // Skip the million-point clouds entirely once they contribute almost nothing.
  // Drawing 2.2M points at 1% alpha costs the same as drawing them at full
  // brightness -- it is the main reason zooming out used to stutter.
  if (starPoints) {
    starPoints.visible =
      stellarAlpha > 0.02 && starMaterial.uniforms.uCatalogFade.value > 0.02;
  }
  if (galaxyPoints) {
    galaxyPoints.visible = stellarAlpha > 0.02;
  }

  if (!clusterPoints) return;

  clusterMaterial.uniforms.uFade.value = blend;
  clusterPoints.visible = blend > 0.001;

  syncGalaxyCamera();
  updateResolvedGalaxies(blend);
}

// Swap each big galaxy from a point to a drawn disc once it is close enough for
// the structure to actually be visible. Below that, a point is the honest
// representation -- a real telescope would not resolve it either.
function updateResolvedGalaxies(blend) {
  if (!resolvedEntries.length) return;

  const resolvedAttr = clusterPoints.geometry.getAttribute('resolvedFade');
  const vpHeight = renderer.domElement.clientHeight || 1;
  // Screen pixels per Mpc at unit distance, from the vertical FOV.
  const projScale =
    vpHeight / (2 * Math.tan(THREE.MathUtils.degToRad(galaxyCamera.fov) / 2));

  for (const entry of resolvedEntries) {
    const dist = Math.max(
      entry.sprite.position.distanceTo(galaxyCamera.position),
      1e-6,
    );
    const px = (entry.diameter / dist) * projScale;

    // Below ~9px there is nothing to see; above ~26px it is fully a disc.
    const detail = THREE.MathUtils.clamp((px - 9) / 17, 0, 1);
    entry.material.opacity = detail * blend * 0.95;
    entry.sprite.visible = entry.material.opacity > 0.01;

    // Tell the point cloud to step aside for this one.
    resolvedAttr.array[entry.index] = detail;
  }
  resolvedAttr.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Frame loop
// ---------------------------------------------------------------------------

function animate() {
  requestAnimationFrame(animate);
  controls.update();

  // Rebase threshold scales with how far out we are. At galactic zoom a fixed
  // 200 pc trigger would rebase every frame and rewrite millions of vertices
  // for no precision benefit; up close it needs to stay tight.
  const rebaseThreshold = Math.max(
    REBASE_DISTANCE,
    zoomLevel() * 0.05,
  );

  if (starPoints && camera.position.distanceTo(lastRebaseAt) > rebaseThreshold) {
    // Shift the world so the camera's current spot becomes the new origin.
    const delta = camera.position.clone();
    rebase(worldOrigin.clone().add(delta));

    // Move camera and orbit target by the same delta. The relationship between
    // them is untouched, so the view does not jump at the moment of rebasing.
    camera.position.sub(delta);
    controls.target.sub(delta);
    lastRebaseAt.copy(camera.position);
  }

  updateHover();
  updateSolarSystem();

  // Cheap enough per frame, and the scale readout should track continuously.
  if (catalogCount) updateStatus();

  // The near plane has to follow the camera down in scale. A fixed 0.01 pc near
  // plane is 2,063 AU -- at solar-system range the planets sit entirely inside
  // it and get clipped away, which looks like they were never drawn.
  const nearWanted = Math.max(camera.position.length() * 1e-4, 1e-9);
  if (Math.abs(camera.near - nearWanted) / camera.near > 0.2) {
    camera.near = nearWanted;
    camera.updateProjectionMatrix();
  }

  // Point size is 1/distance in the shader, so a fixed scale only looks right
  // at one zoom level. Tie it to how far out the camera is, which keeps stars
  // as points from 30 AU to 25 kpc instead of vanishing or swallowing the view.
  // Zoom level, not distance from the origin -- after a rebase the origin is
  // wherever the camera last re-centred, so length() jumps around arbitrarily.
  const viewScale = Math.max(zoomLevel(), 1e-6);

  // Real Gaia coverage reaches ~2.5 kpc for most stars (median ~800 pc), not the
  // small bubble the synthetic stand-in used. Clamp the catalog's point size by
  // roughly its own extent, or from galactic range the whole survey volume
  // saturates into one blown-out patch.
  const catalogScale = Math.min(viewScale, 2500.0);
  starMaterial.uniforms.uSizeScale.value = catalogScale * 1.8;
  pickMaterial.uniforms.uSizeScale.value = catalogScale * 1.8;
  // The backdrop is spread across the whole ~30 kpc disc, so its apparent size
  // depends on how far the camera is from the galaxy, not on how tightly it is
  // zoomed. Using the zoom level made the disc go nearly invisible whenever you
  // flew in close to any part of it.
  // Floor it around the disc's own scale height. Inside the galaxy the nearest
  // backdrop stars are still kiloparsecs away, so a size tied purely to a tight
  // zoom makes every one of them sub-pixel and the disc vanishes.
  galaxyMaterial.uniforms.uSizeScale.value = Math.max(viewScale * 1.4, 9000);

  // Fade the catalog down as the view widens, so the survey bubble stops reading
  // as a second bright core beside the real one.
  //
  // Keyed to ZOOM, not to distance from the Sun. Keying it to the Sun meant
  // flying to the galactic centre -- still surrounded by stars -- dimmed
  // everything to near black purely for being 8 kpc from home.
  starMaterial.uniforms.uCatalogFade.value = THREE.MathUtils.clamp(
    1.0 - (viewScale - 4000) / 16000,
    // Stars stack additively, so even a few percent each saturates to white
    // where the survey volume is dense on screen. The floor has to be very low.
    0.006,
    1.0,
  );

  // Track the selection. The geometry holds absolute coordinates now, so apply
  // the same offset the star cloud itself is drawn with.
  if (starPoints) {
    const p = basePositions;
    const off = starPoints.position;

    const place = (sprite, index, scale) => {
      sprite.position.set(
        p[index * 3] + off.x,
        p[index * 3 + 1] + off.y,
        p[index * 3 + 2] + off.z,
      );
      // Constant apparent size regardless of zoom.
      sprite.scale.setScalar(sprite.position.distanceTo(camera.position) * scale);
    };

    if (selectedIndex >= 0) place(marker, selectedIndex, 0.04);
    if (hoverMarker.visible && hoveredIndex >= 0) place(hoverMarker, hoveredIndex, 0.03);
  }

  updateTiers();

  // Draw the intergalactic tier first, then the stellar tier over it. Each has
  // its own camera and coordinate scale; autoClear is off between them so they
  // composite rather than the second wiping the first.
  renderer.autoClear = true;
  if (clusterPoints && clusterPoints.visible) {
    renderer.render(galaxyScene, galaxyCamera);
    renderer.autoClear = false;
  }
  if (scene.visible) {
    renderer.render(scene, camera);
  }
  renderer.autoClear = true;
}

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  starMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  pickMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();

  galaxyCamera.aspect = camera.aspect;
  galaxyCamera.updateProjectionMatrix();
  if (clusterMaterial) {
    clusterMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
    clusterPickMaterial.uniforms.uPixelRatio.value = renderer.getPixelRatio();
  }
});

// Distance readout picks a unit that suits the current scale, since the range
// spans AU to kiloparsecs.
function formatScale(pc) {
  if (pc < 0.001) return `${(pc / AU_IN_PC).toFixed(1)} AU`;
  if (pc < 1000) return `${pc.toFixed(2)} pc`;
  if (pc < 1e6) return `${(pc / 1000).toFixed(2)} kpc`;
  return `${(pc / 1e6).toFixed(2)} Mpc`;
}

function updateStatus() {
  const sunNow = sunAbsolute.clone().sub(worldOrigin);
  const fromSun = camera.position.distanceTo(sunNow);

  const parts = [];
  if (tierBlend() > 0.25) {
    // Once galaxies dominate the view, the star counts are no longer what you
    // are looking at.
    parts.push(`${clusterCount.toLocaleString()} galaxies`);
  } else {
    parts.push(`${catalogCount.toLocaleString()} Gaia stars`);
    if (proceduralCount) {
      parts.push(`${proceduralCount.toLocaleString()} simulated`);
    }
  }
  parts.push(`${formatScale(fromSun)} from the Sun`);

  document.getElementById('status').textContent = parts.join('  ·  ');
}

// Fly the camera to an absolute galactic position, looking at a target.
function goTo(absoluteTarget, distance, tilt = 0.45) {
  rebase(absoluteTarget.clone());
  lastRebaseAt.set(0, 0, 0);
  controls.target.set(0, 0, 0);
  camera.position.set(0, -distance, distance * tilt);
  lastRebaseAt.copy(camera.position);
  controls.update();
}

document.getElementById('view-cluster').addEventListener('click', () => {
  // Far enough out that the tier fade has fully handed over to the galaxies.
  goTo(new THREE.Vector3(0, 0, 0), 2.2e6, 0.55);
});
document.getElementById('view-galaxy').addEventListener('click', () => {
  goTo(new THREE.Vector3(0, 0, 0), 16000, 1.25);
});
document.getElementById('view-sun').addEventListener('click', () => {
  goTo(sunAbsolute.clone(), 120);
});
document.getElementById('view-solar').addEventListener('click', () => {
  goTo(sunAbsolute.clone(), 40 * AU_IN_PC);
});

async function initGalaxyTier() {
  clusterData = await loadGalaxies('/data/galaxies.bin');
  clusterCount = clusterData.count;

  const built = buildGalaxyPoints(clusterData, renderer);
  clusterPoints = built.points;
  clusterMaterial = built.material;
  clusterPickMaterial = buildGalaxyPickMaterial(renderer);
  clusterPoints.visible = false;
  galaxyScene.add(clusterPoints);

  // The largest galaxies get drawn discs instead of points once close enough.
  const resolved = buildResolvedGalaxies(clusterData, 60);
  resolvedGroup = resolved.group;
  resolvedEntries = resolved.entries;
  galaxyScene.add(resolvedGroup);

  updateStatus();
  return clusterCount;
}

Promise.all([
  loadStars('/data/stars.bin'),
  initGalaxyTier().catch((err) => {
    console.warn('Galaxy tier unavailable:', err.message);
    return null;
  }),
  loadGalaxy('/data/galaxy.bin')
    .then((n) => {
      proceduralCount = n;
      updateStatus();
    })
    .catch(() => null),
]).catch((err) => {
  document.getElementById('status').textContent =
    `${err.message} — generate public/data/stars.bin first (see README).`;
});

animate();
