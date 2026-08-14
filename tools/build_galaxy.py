#!/usr/bin/env python3
"""Generate the procedural Milky Way backdrop.

    python3 tools/build_galaxy.py public/data/galaxy.bin 1500000

These stars are NOT real. Gaia has catalogued ~1.8 billion of the Milky Way's
~100-400 billion stars, and those are heavily concentrated near the Sun -- the
galactic center is behind dust that blocks visible light almost completely.
Anything drawn beyond the catalogued bubble is a plausible invention, sampled
from the standard density model rather than measured.

The viewer keeps these in a separate buffer from the Gaia stars, draws them
dimmer, and refuses to show them in the info panel. Nothing here should ever be
presented as a real object.

Structure (values are the usual textbook ones for the Milky Way):
  - Thin exponential disc, scale length 3000 pc, scale height 300 pc
  - Central bulge, ~1500 pc, roughly spheroidal
  - Four logarithmic spiral arms with angular scatter

Output format 'GALX' v1:
    magic   'GALX'          4 bytes
    version uint32          1
    count   uint32          N
    pad     uint32          0
    pos     float32[N*3]    x,y,z in parsecs, galactic center at origin
    color   uint8[N*3]      r,g,b
    mag     float32[N]      fake apparent magnitude, for size variation
"""

import math
import random
import struct
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build_stars import bp_rp_to_temp, kelvin_to_rgb  # noqa: E402

DISC_SCALE_LENGTH = 3000.0   # pc
DISC_SCALE_HEIGHT = 300.0    # pc
DISC_MAX_RADIUS = 16000.0    # pc, roughly where the stellar disc fades out
BULGE_RADIUS = 1500.0        # pc
ARM_COUNT = 4
ARM_PITCH = 0.22             # radians of winding per unit ln(r)
ARM_SPREAD = 0.55            # radians of scatter around the arm ridge

BULGE_FRACTION = 0.22        # share of stars in the bulge
ARM_FRACTION = 0.55          # share of disc stars pulled onto arms


def sample_bulge():
    # Roughly spheroidal, denser toward the middle, slightly flattened in z.
    r = BULGE_RADIUS * random.random() ** 0.6
    theta = random.uniform(0, 2 * math.pi)
    phi = math.acos(random.uniform(-1, 1))
    return (
        r * math.sin(phi) * math.cos(theta),
        r * math.sin(phi) * math.sin(theta),
        r * math.cos(phi) * 0.6,
    )


def sample_disc():
    # Exponential in radius: -ln(u) gives the exponential distribution.
    r = -DISC_SCALE_LENGTH * math.log(max(random.random(), 1e-9))
    if r > DISC_MAX_RADIUS:
        r = random.uniform(0, DISC_MAX_RADIUS)

    if random.random() < ARM_FRACTION and r > BULGE_RADIUS:
        # Logarithmic spiral: theta = ln(r)/pitch, offset per arm.
        arm = random.randrange(ARM_COUNT)
        base = math.log(r / BULGE_RADIUS) / ARM_PITCH
        theta = base + arm * (2 * math.pi / ARM_COUNT)
        # Scatter widens outward, so arms stay tight near the core.
        theta += random.gauss(0, ARM_SPREAD * (0.4 + 0.6 * r / DISC_MAX_RADIUS))
    else:
        theta = random.uniform(0, 2 * math.pi)

    # Vertical profile: exponential, thicker at large radii (disc flaring).
    flare = 1.0 + 1.5 * (r / DISC_MAX_RADIUS)
    z = random.gauss(0, DISC_SCALE_HEIGHT * flare)

    return r * math.cos(theta), r * math.sin(theta), z


def main():
    dst = sys.argv[1] if len(sys.argv) > 1 else "public/data/galaxy.bin"
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 1_500_000

    random.seed(7)
    positions, colors, mags = [], [], []

    for _ in range(count):
        if random.random() < BULGE_FRACTION:
            x, y, z = sample_bulge()
            # Bulge skews old and red.
            bp_rp = random.gauss(1.5, 0.4)
        else:
            x, y, z = sample_disc()
            # Disc has more young blue stars, especially on the arms.
            bp_rp = random.gauss(0.8, 0.5)

        positions.extend((x, y, z))
        colors.extend(kelvin_to_rgb(bp_rp_to_temp(max(-0.3, min(3.5, bp_rp)))))
        mags.append(max(1.0, min(14.0, random.gauss(9.0, 2.5))))

    with open(dst, "wb") as out:
        out.write(b"GALX")
        out.write(struct.pack("<III", 1, count, 0))
        out.write(struct.pack(f"<{count * 3}f", *positions))
        out.write(bytes(colors))
        out.write(struct.pack(f"<{count}f", *mags))

    size_mb = (16 + count * 16) / 1e6
    print(f"Wrote {count:,} procedural stars to {dst} ({size_mb:.1f} MB).")


if __name__ == "__main__":
    main()
