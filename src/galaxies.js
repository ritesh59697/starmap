import * as THREE from 'three';

// ---------------------------------------------------------------------------
// Intergalactic tier: real galaxies from the Local Group out to Virgo.
//
// This tier works in MEGAPARSECS while the stellar tier works in parsecs -- a
// factor of a million. Putting both in one scene would blow float32 precision
// apart: the Milky Way's own stars would round to a single point, or the Virgo
// Cluster would overflow. So this gets its own scene and its own camera, and
// main.js cross-fades between the two rather than trying to span both at once.
// ---------------------------------------------------------------------------

export const MPC_IN_PC = 1e6;

export function ttypeLabel(tt) {
  if (Number.isNaN(tt)) return 'unknown';
  if (tt < -3.5) return 'Elliptical';
  if (tt < 0.5) return 'Lenticular (S0)';
  if (tt < 2.5) return 'Spiral (early)';
  if (tt < 5.0) return 'Spiral (Sb/Sc)';
  if (tt < 9.0) return 'Spiral (late)';
  return 'Irregular';
}

export async function loadGalaxies(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const buf = await res.arrayBuffer();

  const magic = new TextDecoder().decode(new Uint8Array(buf, 0, 4));
  if (magic !== 'GLXY') throw new Error('Not a galaxy catalog binary.');

  const [, count, nameLen] = new Uint32Array(buf, 4, 3);

  let o = 16;
  const positions = new Float32Array(buf.slice(o, o + count * 12));
  o += count * 12;
  const colors = new Uint8Array(buf.slice(o, o + count * 3));
  o += count * 3;
  const sizes = new Float32Array(buf.slice(o, o + count * 4));
  o += count * 4;
  const dists = new Float32Array(buf.slice(o, o + count * 4));
  o += count * 4;
  const bmags = new Float32Array(buf.slice(o, o + count * 4));
  o += count * 4;
  const ttypes = new Float32Array(buf.slice(o, o + count * 4));
  o += count * 4;
  const nameOffsets = new Uint32Array(buf.slice(o, o + (count + 1) * 4));
  o += (count + 1) * 4;
  const nameBlob = new Uint8Array(buf.slice(o, o + nameLen));

  const decoder = new TextDecoder();
  const nameAt = (i) =>
    decoder.decode(nameBlob.subarray(nameOffsets[i], nameOffsets[i + 1]));

  return { count, positions, colors, sizes, dists, bmags, ttypes, nameAt };
}

export function buildGalaxyPoints(data, renderer) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
  geometry.setAttribute('galaxyColor', new THREE.BufferAttribute(data.colors, 3, true));
  geometry.setAttribute('galaxySize', new THREE.BufferAttribute(data.sizes, 1));

  const indices = new Float32Array(data.count);
  for (let i = 0; i < data.count; i++) indices[i] = i;
  geometry.setAttribute('galaxyIndex', new THREE.BufferAttribute(indices, 1));

  // Written by updateResolvedGalaxies for the handful drawn as discs.
  geometry.setAttribute(
    'resolvedFade',
    new THREE.BufferAttribute(new Float32Array(data.count), 1),
  );

  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: renderer.getPixelRatio() },
      uSizeScale: { value: 40.0 },
      uFade: { value: 1.0 },
    },
    vertexShader: /* glsl */ `
      attribute vec3 galaxyColor;
      attribute float galaxySize;
      attribute float resolvedFade;

      uniform float uPixelRatio;
      uniform float uSizeScale;

      varying vec3 vColor;
      varying float vResolved;

      void main() {
        vColor = galaxyColor;
        // 1 while this galaxy is drawn as a resolved disc, so the point sprite
        // can get out of the way instead of sitting as a dot in its centre.
        vResolved = resolvedFade;

        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPos;

        float dist = max(length(viewPos.xyz), 1e-4);
        // Bigger galaxies really are bigger on screen, unlike the star tier
        // where every point is effectively unresolved.
        gl_PointSize = clamp(
          galaxySize * uSizeScale * uPixelRatio / dist,
          3.5 * uPixelRatio,
          140.0 * uPixelRatio
        );
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uFade;
      varying vec3 vColor;
      varying float vResolved;

      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        float r = length(d) * 2.0;
        if (r > 1.0) discard;

        // Soft elliptical-looking falloff: bright core, broad halo. Unlike the
        // star tiers there are only thousands of these, so they can carry full
        // brightness without additive blending saturating the frame.
        float core = pow(1.0 - r, 2.0);
        float halo = pow(1.0 - r, 0.6) * 0.5;
        gl_FragColor = vec4(vColor * 1.4, (core + halo) * uFade * (1.0 - vResolved));
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  return { points, material };
}

// ---------------------------------------------------------------------------
// Resolved galaxy sprites
//
// Point sprites cannot show structure -- Andromeda ends up a fuzzy dot. The
// biggest galaxies get a real billboarded sprite with a procedurally drawn
// disc instead, sized from the catalog's angular diameter so the scale is
// honest even though the pattern is generic.
//
// These are illustrations of morphology, not images of the actual galaxies. A
// spiral is drawn as a spiral and an elliptical as a smooth bulge; the arm
// count and winding are invented.
// ---------------------------------------------------------------------------

function drawSpiralTexture({ arms = 2, winding = 2.4, coreSize = 0.13 } = {}) {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');
  const cx = S / 2;
  const cy = S / 2;

  ctx.clearRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'lighter';

  // Arms: scatter points along logarithmic spirals, denser toward the centre.
  for (let a = 0; a < arms; a++) {
    const phase = (a / arms) * Math.PI * 2;
    for (let i = 0; i < 2600; i++) {
      const t = i / 2600;
      const r = Math.pow(t, 0.62) * (S * 0.46);
      const theta = phase + Math.log(1 + t * winding * 6) * winding;

      // Spread widens outward, so arms stay tight near the core.
      const spread = (0.055 + t * 0.20) * S * 0.35;
      const jx = (Math.random() - 0.5) * spread;
      const jy = (Math.random() - 0.5) * spread;

      const x = cx + Math.cos(theta) * r + jx;
      const y = cy + Math.sin(theta) * r + jy;

      // Young blue stars dominate the outer arms, older yellow ones inside.
      const blue = Math.min(255, 150 + t * 105);
      const warm = Math.max(120, 245 - t * 90);
      ctx.fillStyle = `rgba(${warm | 0}, ${(warm * 0.93) | 0}, ${blue | 0}, ${0.16 * (1 - t * 0.55)})`;
      ctx.beginPath();
      ctx.arc(x, y, 1.15, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Central bulge.
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, S * coreSize * 2.4);
  g.addColorStop(0, 'rgba(255, 246, 220, 0.95)');
  g.addColorStop(0.35, 'rgba(255, 226, 165, 0.45)');
  g.addColorStop(1, 'rgba(255, 210, 150, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

function drawEllipticalTexture() {
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d');

  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.5);
  g.addColorStop(0, 'rgba(255, 244, 214, 0.98)');
  g.addColorStop(0.18, 'rgba(255, 226, 176, 0.62)');
  g.addColorStop(0.5, 'rgba(252, 206, 150, 0.20)');
  g.addColorStop(1, 'rgba(240, 190, 140, 0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

// Built once and shared; per-galaxy variety comes from picking among them.
let sharedTextures = null;
function getTextures() {
  if (!sharedTextures) {
    sharedTextures = {
      spiral: [
        drawSpiralTexture({ arms: 2, winding: 2.4 }),
        drawSpiralTexture({ arms: 4, winding: 1.9 }),
        drawSpiralTexture({ arms: 3, winding: 2.8 }),
      ],
      elliptical: drawEllipticalTexture(),
    };
  }
  return sharedTextures;
}

// Which galaxies are worth resolving. Sprite count stays small -- these are
// individual draw calls, unlike the point cloud.
export function buildResolvedGalaxies(data, maxCount = 60) {
  const tex = getTextures();

  // Rank by apparent size: physical size over distance.
  const order = [];
  for (let i = 0; i < data.count; i++) {
    const s = data.sizes[i];
    const d = data.dists[i];
    if (!(s > 0) || !(d > 0)) continue;
    order.push([i, s / d]);
  }
  order.sort((a, b) => b[1] - a[1]);

  const group = new THREE.Group();
  const entries = [];

  for (const [index] of order.slice(0, maxCount)) {
    const tt = data.ttypes[index];
    const isElliptical = !Number.isNaN(tt) && tt < 0.5;

    const map = isElliptical
      ? tex.elliptical
      : tex.spiral[index % tex.spiral.length];

    const material = new THREE.SpriteMaterial({
      map,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      opacity: 0,
      color: new THREE.Color(
        data.colors[index * 3] / 255,
        data.colors[index * 3 + 1] / 255,
        data.colors[index * 3 + 2] / 255,
      ).lerp(new THREE.Color(1, 1, 1), 0.55),
    });

    const sprite = new THREE.Sprite(material);
    sprite.position.set(
      data.positions[index * 3],
      data.positions[index * 3 + 1],
      data.positions[index * 3 + 2],
    );

    // The catalog's size is the galaxy's actual extent in Mpc. The drawn disc
    // fills about half the texture, so scale up to compensate.
    const diameter = Math.max(data.sizes[index], 0.004) * 2.4;
    sprite.scale.setScalar(diameter);
    sprite.renderOrder = 1;

    group.add(sprite);
    entries.push({ index, sprite, material, diameter });
  }

  return { group, entries };
}

// Pick material mirrors the size formula so what you see is what you can click.
export function buildGalaxyPickMaterial(renderer) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uPixelRatio: { value: renderer.getPixelRatio() },
      uSizeScale: { value: 40.0 },
    },
    vertexShader: /* glsl */ `
      attribute float galaxySize;
      attribute float galaxyIndex;

      uniform float uPixelRatio;
      uniform float uSizeScale;

      varying vec4 vId;

      void main() {
        float id = galaxyIndex + 1.0;
        vId = vec4(
          mod(id, 256.0),
          mod(floor(id / 256.0), 256.0),
          mod(floor(id / 65536.0), 256.0),
          floor(id / 16777216.0)
        ) / 255.0;

        vec4 viewPos = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * viewPos;

        float dist = max(length(viewPos.xyz), 1e-4);
        // Upper bound is generous: galaxies drawn as resolved discs are far
        // larger on screen than the point sprite, and the clickable area has to
        // cover what is actually visible, not the unresolved dot.
        gl_PointSize = clamp(
          galaxySize * uSizeScale * uPixelRatio / dist,
          8.0 * uPixelRatio,
          600.0 * uPixelRatio
        );
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec4 vId;
      void main() {
        vec2 d = gl_PointCoord - vec2(0.5);
        if (length(d) * 2.0 > 1.0) discard;
        gl_FragColor = vId;
      }
    `,
    transparent: false,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NoBlending,
  });
}
