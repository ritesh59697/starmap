# Starmap

A 3D map of the universe in four tiers — Local Group and Virgo Cluster, the Milky Way,
the Sun's neighbourhood, the solar system — built on real catalog data and traversable
by continuous zoom, Powers of Ten style.

| tier | scale | source |
|---|---|---|
| Local Group → Virgo | 0.05–25 Mpc | 6,330 real galaxies (GWGC) |
| Milky Way | ~30 kpc | 1.2M procedural stars |
| Sun's neighbourhood | 1–3000 pc | 1.0M real Gaia DR3 stars |
| Solar system | 0.4–30 AU | 8 planets, real orbital distances |

Scrolling crosses tier boundaries automatically, each fading in as the previous fades
out; the buttons jump directly.

## Run it

```bash
npm install

# Sun's neighbourhood: real Gaia stars (~92MB download)
./tools/fetch_gaia.sh gaia_dr3.csv 11
python3 tools/build_stars.py gaia_dr3.csv public/data/stars.bin

# Milky Way backdrop: procedural, no download
python3 tools/build_galaxy.py public/data/galaxy.bin 1200000

# Local Group and Virgo: real galaxies (~1MB download)
./tools/fetch_galaxies.sh gwgc.tsv 25
python3 tools/build_galaxies.py gwgc.tsv public/data/galaxies.bin

npm run dev
```

To skip the Gaia download and check the renderer first, substitute synthetic stars
shaped like the real catalog's distribution:

```bash
python3 tools/make_sample.py public/data/stars.bin 200000
```

## Real Gaia data

The checked-in setup uses **1,012,490 real Gaia DR3 stars** (G < 11). To reproduce:

```bash
./tools/fetch_gaia.sh gaia_dr3.csv 11
python3 tools/build_stars.py gaia_dr3.csv public/data/stars.bin
```

The script uses ESA's public TAP service — no login. It submits an async job, polls
until it completes, and downloads the CSV (~92MB for G<11). Conversion takes under
3 seconds and produces a 32MB binary at 32 bytes/star.

Star counts roughly double per magnitude, so the cut is the main performance lever.
All three of these were built and measured:

| cut | stars | CSV | binary |
|---|---|---|---|
| G < 11 | 1,012,490 | 92MB | 32MB |
| G < 12 | 2,407,696 | 220MB | 77MB |
| G < 13 | 3,000,000 (capped) | 274MB | 96MB |

Over half of a G<12 pull sits in the faintest bin alone (1.4M stars at G 11–12), which
is why dropping one magnitude cuts far more than it sounds like it should.

If you change the cut, update the magnitude normalisation in **both** shaders in
`src/main.js` to match — `clamp((11.0 - magnitude) / 11.0, ...)` appears in the visual
shader and again in the pick shader, and they must stay identical or stars become
visible but unclickable.

One archive quirk: **anonymous async jobs are capped at 3,000,000 rows.** G<11 and G<12
come in under it. A G<13 cut matches ~4M and comes back silently truncated to the 3M
brightest — a service limit, not a bug in the query.

For anything bigger, use the octree streaming loader described under Next steps.

Prefer the web UI? `tools/gaia_query.adql` holds the same query for pasting into
[the archive's ADQL form](https://gea.esac.esa.int/archive/).

### What the data actually looks like

Real coverage is nothing like a tidy sphere around the Sun. For the G<13 cut the
distances ran:

| percentile | distance |
|---|---|
| 50% | 792 pc |
| 90% | 2,505 pc |
| 99% | 4,776 pc |
| max | 11,478 pc |

G<12 is similar in shape, slightly nearer on average — brighter stars, so the tail is
a little shorter.

At galactic zoom the survey volume shows up as a cone-shaped patch offset from the
centre — that shape is real. Gaia sees far along sightlines out of the galactic plane
and barely at all through it, because dust blocks visible light. The lopsidedness is
the data being honest about what we have and haven't measured.

## How it works

**`tools/build_stars.py`** does the astronomy once, offline: parallax (mas) → distance
(parsecs) via `1000/parallax`, then RA/Dec/distance → Cartesian xyz. Color index →
temperature → RGB. The browser just uploads finished buffers.

**`src/main.js`** holds the true camera position in float64 on the CPU. When the camera
drifts more than `REBASE_DISTANCE`, the world is shifted so the camera's current spot
becomes the new origin and the camera is moved back by the same delta — the view is
unchanged, but GPU-side coordinates stay small.

The shift moves the **object**, not the vertices. Geometry keeps its original absolute
coordinates and `starPoints.position` carries the offset, which Three.js folds into the
model matrix on the GPU for free. The earlier version rewrote every vertex on the CPU
and re-uploaded the buffer, which at 2.4M stars meant ~29MB per rebase and a visible
hitch each time the camera drifted. Precision is unaffected: the subtraction still
happens in the shader, and the offset is tracked in float64 on the CPU.

**Picking** is done on the GPU, not by raycasting. On click, the points are re-rendered
into a 1×1 render target with each star's index encoded as RGBA, and that single pixel is
read back. Cost is independent of star count, so it works the same at 200k or 20M.
`camera.setViewOffset` restricts the render to just the pixel under the cursor rather than
drawing a full frame and cropping.

Three things the pick pass must get right, each of which silently breaks it:
- Clear the target to **all zero, alpha included**. The default clear alpha is 1, which
  decodes as index `255 * 16777216` — every click on empty sky returns a bogus hit.
- Use `NoBlending` and `depthWrite: true`. The visual pass uses additive blending with
  depth writes off, which is correct for glowing points but would corrupt an id buffer.
- Mirror the visual shader's `gl_PointSize`, but with a larger minimum
  (`PICK_MIN_SIZE`). Otherwise faint one-pixel stars are visible but effectively
  unclickable.

Two more details that are easy to get wrong:
- `logarithmicDepthBuffer` is on — a 0.01 near plane with a 1e7 far plane will z-fight badly otherwise.
- The bounding sphere is forced to `Infinity` and frustum culling disabled. A bounding
  sphere computed from absolute coordinates goes stale the moment you rebase, and the
  whole cloud pops out of view.

## Real vs simulated

This is the thing to be clear about. The Milky Way has 100–400 billion stars. Gaia has
catalogued ~1.8 billion of them — under 1% — and those are heavily biased toward the
Sun's neighbourhood, because the galactic centre sits behind dust that blocks visible
light almost entirely. **There is no catalog of every Milky Way star**, so any view of
the whole galaxy is necessarily part invention.

The viewer keeps the two strictly separate:

| | Gaia stars (`stars.bin`) | Procedural (`galaxy.bin`) |
|---|---|---|
| Count | 1,012,490 | 1,200,000 |
| Source | real Gaia DR3 measurements | sampled from the density model |
| Position | parallax-derived | exponential disc + bulge + log spirals |
| Identity | real `source_id`, looks up in the archive | none |
| Clickable | yes, with catalog values | **never** — picking returns nothing |
| Brightness | full | dimmer, fades in at wide zoom |

Every clickable star's `source_id` is a real Gaia identifier. Verified end to end: a
star picked in the viewer reported parallax 0.539 mas / G 10.99 / BP−RP 1.473, and
querying `source_id = 5698696615620241536` against the live archive returns
0.5390165 / 10.992542 / 1.4728928.

The procedural layer is excluded from the pick pass entirely, so it is not possible to
click an invented star and be shown numbers that look authoritative. The status bar
always reports both counts, labelling the second "simulated".

## Why two scenes

The intergalactic tier works in **megaparsecs**; the stellar tier works in **parsecs**.
That is a factor of a million, and the full span from a planet (~1e-13 Mpc) to Virgo
(~25 Mpc) is about 17 orders of magnitude. Float64 carries ~15–16 significant digits, so
**no single coordinate frame can hold both ends**. Trying it means either the solar
system collapses to a point or the far galaxies lose all precision.

So each tier gets its own `THREE.Scene` and its own camera, drawn in sequence with
`autoClear` off between them so they composite. One set of `OrbitControls` drives the
stellar camera, and `syncGalaxyCamera()` mirrors it into megaparsec space — a straight
divide by 1e6, since both frames are centred on the Milky Way. That is what makes a
single continuous scroll carry you across the boundary.

`tierBlend()` returns 0…1 over the fade band (`TIER_FADE_START` → `TIER_FADE_END`), and
both tiers multiply their alpha by it. Mid-fade you see the Milky Way shrinking to a
point while its neighbours emerge around it.

One thing that bit me: `pickGalaxyAt()` calls `syncGalaxyCamera()` itself rather than
relying on the frame loop having run. Picking must not depend on frame-loop ordering —
if a click arrives before the first frame after a view change, the camera is still at
its old position and every pick misses.

## Fades key off zoom, never off position

Every brightness fade uses `zoomLevel()` — the camera-to-orbit-target distance — and
**not** distance from the Sun or from the galactic centre. This matters enough to state
plainly, because getting it wrong is subtle and looks like a rendering failure:

Keyed to the Sun, flying to the galactic centre would dim the star catalog to its floor
purely for being 8 kpc from home, even though the camera is surrounded by stars. The
screen goes black at a position where it should be at its brightest. Position tells you
*where* you are; only zoom tells you *how much* you should be seeing.

The procedural backdrop also has a size floor (`Math.max(viewScale * 1.4, 9000)`). Its
stars are spread across a ~30 kpc disc, so when you fly inside it the nearest ones are
still kiloparsecs away — scaling their point size purely by a tight zoom made every one
sub-pixel and the whole disc disappeared.

## Resolved galaxies

The ~60 largest galaxies (ranked by angular size — physical size over distance) are
drawn as billboarded sprites with procedurally generated discs instead of points, fading
in once they exceed ~9px on screen and fully resolved by ~26px. Below that a point is
the honest representation; a real telescope would not resolve them either.

**These are morphology illustrations, not images.** A spiral is drawn as a spiral and an
elliptical as a smooth bulge, driven by the catalog's T-type, but the arm count and
winding are invented. The *size* is real — taken from the catalog's angular diameter.

Two implementation notes:

- The point cloud carries a `resolvedFade` attribute so a galaxy's point sprite fades
  out as its disc fades in. Otherwise there is a bright dot sitting in the middle of
  every spiral.
- Resolved galaxies need their own hit test (`pickResolvedGalaxyAt`), which projects
  each sprite to screen space and compares radii. The GPU point-buffer pick uses the
  *point* size, which is many times smaller than the drawn disc — so clicking a visible
  spiral hit nothing.

## Local Group data

`tools/fetch_galaxies.sh` pulls the Gravitational Wave Galaxy Catalogue (White et al.
2011, VizieR VII/267) — real galaxies with measured distances out to 25 Mpc, which
covers Virgo at ~16.5 Mpc. Small download, ~1MB.

Two filters in `build_galaxies.py` matter:

- **`TT = -9` rows are Milky Way globular clusters, not galaxies.** They dominate the
  nearby end of the catalog (135 of them inside 25 Mpc) and showing them as galaxies
  would be plain wrong.
- **`GALCENTER` is a placeholder** for the Milky Way's own centre. We render the Milky
  Way properly in its own tier, so this would be a duplicate.

The catalog uses survey designations, so `COMMON_NAMES` maps the famous ones to what
people actually call them — "NGC0224" becomes "Andromeda (M31)". Spot-checked against
published distances: LMC 0.05 Mpc, SMC 0.06, Andromeda 0.79, Triangulum 0.84,
Centaurus A 3.77, M87 17.22 Mpc.

## Coordinates

Everything is in the galactic frame with the galactic centre at the origin. Gaia
coordinates are Sun-centred, so they are shifted by `SUN_GALACTIC_X` (−8178 pc, the
GRAVITY collaboration's 2019 measurement) on load. That is why the info panel reports
both "From Earth" and "From gal. center" — the former subtracts the Sun's position back
out, the latter is distance from the origin.

## Scale traversal

The view spans roughly 10 orders of magnitude, from ~30 AU to ~25 kpc. Three things
scale with the camera each frame, and each one breaks the view if left fixed:

- **Near plane.** A fixed 0.01 pc near plane is 2,063 AU — at solar-system range the
  planets sit entirely inside it and are clipped away. It looks exactly like they were
  never drawn.
- **Point size.** `gl_PointSize` is `1/distance`, so a constant scale is only correct at
  one zoom level. The catalog's own size is additionally clamped, because 200k stars in a
  400 pc bubble otherwise saturate into one white disc when seen from 25 kpc.
- **Rebase threshold.** A fixed 200 pc trigger rebases every frame at galactic zoom,
  rewriting millions of vertices for no precision gain.

## Data format

`stars.bin` is version 2. Beyond position/color/magnitude it carries `source_id`,
`bp_rp`, and `parallax` so the info panel has real catalog values to show. v1 files
still load — they just show position-derived fields only.

`source_id` is a 64-bit integer beyond float64's exact-integer range, so it is stored
as two uint32 halves and reassembled with `BigInt` in the viewer. Storing it as a plain
float would corrupt the low digits of every id.

## Solar system

`src/solarsystem.js` places the Sun and 8 planets at correct relative orbital distances
(0.39–30 AU). Two deliberate departures from reality, both standard for this kind of map:

- **Body sizes are exaggerated ~1200×.** At true scale every planet is far below one
  pixel next to its own orbit. Orbital *distances* are accurate; only the spheres are
  inflated. The Sun is exaggerated less, or it would swallow Mercury's orbit.
- **Positions are a static snapshot.** Planets sit at spread-out fixed angles rather than
  true positions for a date. Real ephemerides would need Keplerian elements and a
  date control.

Planets use a raycast rather than the GPU pick buffer — there are 9 of them, so the
million-point machinery would be pointless.

## Next steps

- **Real planet positions**: Keplerian orbital elements plus a date slider, so the
  planets sit where they actually are on a given day.
- **Beyond ~5M stars**: bake the catalog into an octree and stream nodes by camera
  distance. [Potree](https://github.com/potree/potree) is the reference implementation;
  [Gaia Sky](https://github.com/langurmonkey/gaiasky) shows how the scale tiers are handled.
- **Named stars**: cross-match `source_id` against Hipparcos/Tycho for common names.

## License

Code is MIT — see [LICENSE](LICENSE).

The astronomical data is not mine and is not covered by that license. It is downloaded
at build time, not redistributed here, and each source has its own terms:

- **Gaia DR3** — ESA/Gaia/DPAC. Free to use with acknowledgement; see the
  [Gaia credit and citation instructions](https://gea.esac.esa.int/archive/documentation/credits.html).
- **Gravitational Wave Galaxy Catalogue** — White, Daw & Dhillon (2011), via
  [VizieR VII/267](https://cdsarc.cds.unistra.fr/viz-bin/cat/VII/267). Cite the paper if
  you use it; VizieR/CDS terms apply.

If you publish anything built on this, credit those sources rather than this repo.
