import * as THREE from 'three';

// The solar system is ~30 AU across; a parsec is 206,265 AU. So the whole thing
// spans about 1.5e-4 pc -- roughly ten orders of magnitude below the galactic
// scale. It is a single invisible speck until the camera is almost inside it.
//
// Positions here are a static snapshot at mean orbital distance, not real
// ephemerides. Planets are placed at spread-out angles so they don't line up in
// a row, which never happens in reality.

export const AU_IN_PC = 1 / 206264.806;

// radiusKm is used only for relative sizing; the Sun is scaled down separately
// because at true scale it would dwarf every planet into invisibility.
export const PLANETS = [
  { name: 'Mercury', au: 0.387, radiusKm: 2440, color: 0x8c7853, angle: 0.4 },
  { name: 'Venus', au: 0.723, radiusKm: 6052, color: 0xe8cda2, angle: 1.9 },
  { name: 'Earth', au: 1.0, radiusKm: 6371, color: 0x4a7fc1, angle: 3.1 },
  { name: 'Mars', au: 1.524, radiusKm: 3390, color: 0xc1440e, angle: 4.6 },
  { name: 'Jupiter', au: 5.203, radiusKm: 69911, color: 0xd8ca9d, angle: 0.9 },
  { name: 'Saturn', au: 9.537, radiusKm: 58232, color: 0xead6b8, angle: 2.6 },
  { name: 'Uranus', au: 19.191, radiusKm: 25362, color: 0xa8d8e8, angle: 5.2 },
  { name: 'Neptune', au: 30.069, radiusKm: 24622, color: 0x4b70dd, angle: 1.2 },
];

export const PLANET_FACTS = {
  Mercury: { day: '58.6 Earth days', year: '88 days', moons: 0, temp: '−173 to 427 °C' },
  Venus: { day: '243 Earth days', year: '225 days', moons: 0, temp: '464 °C' },
  Earth: { day: '24 hours', year: '365.25 days', moons: 1, temp: '−88 to 58 °C' },
  Mars: { day: '24.6 hours', year: '687 days', moons: 2, temp: '−143 to 35 °C' },
  Jupiter: { day: '9.9 hours', year: '11.9 years', moons: 95, temp: '−145 °C' },
  Saturn: { day: '10.7 hours', year: '29.4 years', moons: 146, temp: '−178 °C' },
  Uranus: { day: '17.2 hours', year: '84 years', moons: 28, temp: '−224 °C' },
  Neptune: { day: '16.1 hours', year: '164.8 years', moons: 16, temp: '−214 °C' },
};

// Planets rendered at true scale would be sub-pixel next to their orbits, so
// sizes are exaggerated by a constant factor. Orbit *distances* stay accurate --
// only the bodies are inflated, which is the usual convention for these maps.
const BODY_EXAGGERATION = 1200;
const KM_IN_PC = 1 / 3.086e13;

export function buildSolarSystem(sunPosition) {
  const group = new THREE.Group();
  group.position.copy(sunPosition);

  const bodies = [];

  // The Sun. Exaggerated less than the planets, or it would swallow Mercury.
  const sunRadius = 696340 * KM_IN_PC * BODY_EXAGGERATION * 0.15;
  const sun = new THREE.Mesh(
    new THREE.SphereGeometry(sunRadius, 32, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd88a }),
  );
  group.add(sun);
  bodies.push({ name: 'Sun', mesh: sun, au: 0 });

  for (const p of PLANETS) {
    const distPc = p.au * AU_IN_PC;
    const radiusPc = p.radiusKm * KM_IN_PC * BODY_EXAGGERATION;

    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(radiusPc, 1e-9), 24, 24),
      new THREE.MeshBasicMaterial({ color: p.color }),
    );
    mesh.position.set(
      Math.cos(p.angle) * distPc,
      Math.sin(p.angle) * distPc,
      0,
    );
    group.add(mesh);
    bodies.push({ name: p.name, mesh, au: p.au });

    // Orbit ring, so the layout reads even when the planet is sub-pixel.
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(distPc * 0.9995, distPc * 1.0005, 128),
      new THREE.MeshBasicMaterial({
        color: 0x5577aa,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.35,
      }),
    );
    group.add(ring);
  }

  return { group, bodies };
}
