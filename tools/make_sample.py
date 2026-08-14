#!/usr/bin/env python3
"""Generate a synthetic stars.bin so the viewer runs before the Gaia export lands.

    python3 tools/make_sample.py public/data/stars.bin 200000

This is fake data shaped roughly like a disc galaxy -- useful for checking the
renderer and the floating origin, useless for astronomy. Replace it with a real
Gaia export via build_stars.py.
"""

import math
import random
import struct
import sys

sys.path.insert(0, __file__.rsplit("/", 1)[0])
from build_stars import bp_rp_to_temp, kelvin_to_rgb  # noqa: E402


def main():
    dst = sys.argv[1] if len(sys.argv) > 1 else "public/data/stars.bin"
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 200_000

    random.seed(42)
    positions, colors, mags = [], [], []
    source_ids, bp_rps, parallaxes = [], [], []

    for i in range(count):
        # Gaia's well-measured stars form a volume around the Sun, not a whole
        # galaxy -- the catalog thins out with distance and the galactic center
        # is hidden behind dust. The real G<13 cut has a median distance around
        # 800 pc and a long tail, so weight the radius to approximate that
        # rather than filling a uniform ball.
        r = 3000.0 * random.random() ** 2.2
        theta = random.uniform(0, 2 * math.pi)
        phi = math.acos(random.uniform(-1, 1))

        positions.append(r * math.sin(phi) * math.cos(theta))
        positions.append(r * math.sin(phi) * math.sin(theta))
        # Slightly flattened toward the galactic plane.
        positions.append(r * math.cos(phi) * 0.7)

        bp_rp = max(-0.3, min(3.5, random.gauss(0.9, 0.55)))
        colors.extend(kelvin_to_rgb(bp_rp_to_temp(bp_rp)))
        mags.append(max(0.5, min(13.0, random.gauss(11.0, 1.6))))

        # Fake ids in the same 64-bit range Gaia uses, so the lo/hi split and
        # the viewer's BigInt reassembly get exercised by sample data too.
        fake_id = 4_295_000_000_000_000_000 + i
        source_ids.append(fake_id & 0xFFFFFFFF)
        source_ids.append((fake_id >> 32) & 0xFFFFFFFF)
        bp_rps.append(bp_rp)

        # Distance back to parallax in mas, so the info panel has something real
        # to divide. r is the 3D distance from the origin.
        dist = math.sqrt(positions[-3] ** 2 + positions[-2] ** 2 + positions[-1] ** 2)
        parallaxes.append(1000.0 / max(dist, 1e-6))

    with open(dst, "wb") as out:
        out.write(b"STAR")
        out.write(struct.pack("<III", 2, count, 0))
        out.write(struct.pack(f"<{count * 3}f", *positions))
        out.write(bytes(colors))
        out.write(struct.pack(f"<{count}f", *mags))
        out.write(struct.pack(f"<{count * 2}I", *source_ids))
        out.write(struct.pack(f"<{count}f", *bp_rps))
        out.write(struct.pack(f"<{count}f", *parallaxes))

    print(f"Wrote {count:,} synthetic stars to {dst}.")


if __name__ == "__main__":
    main()
