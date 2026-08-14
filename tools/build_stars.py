#!/usr/bin/env python3
"""Convert a Gaia DR3 CSV export into a compact binary the viewer can load.

    python3 tools/build_stars.py gaia_result.csv public/data/stars.bin

Output layout (little-endian), header then parallel arrays:

    magic   'STAR'          4 bytes
    version uint32          2
    count   uint32          N
    pad     uint32          0
    pos     float32[N*3]    x,y,z in parsecs, galactic-ish equatorial frame
    color   uint8[N*3]      r,g,b
    mag     float32[N]      apparent G magnitude
    srcid   uint32[N*2]     Gaia source_id, split lo/hi (v2+)
    bp_rp   float32[N]      color index (v2+)
    plx     float32[N]      parallax in mas (v2+)

Positions stay float32 because the viewer re-centers them against a floating
origin before they ever reach the GPU; see src/main.js.

source_id is a 64-bit integer larger than float64 can hold exactly, so it is
stored as two uint32 halves and reassembled with BigInt in the viewer.
"""

import csv
import math
import struct
import sys

# Temperature -> RGB, adapted from Tanner Helland's blackbody approximation.
# Good enough visually for stars; not photometrically exact.
def kelvin_to_rgb(temp_k):
    t = max(1000.0, min(40000.0, temp_k)) / 100.0

    if t <= 66:
        r = 255.0
        g = 99.4708025861 * math.log(t) - 161.1195681661 if t > 0 else 0.0
    else:
        r = 329.698727446 * ((t - 60) ** -0.1332047592)
        g = 288.1221695283 * ((t - 60) ** -0.0755148492)

    if t >= 66:
        b = 255.0
    elif t <= 19:
        b = 0.0
    else:
        b = 138.5177312231 * math.log(t - 10) - 305.0447927307

    clamp = lambda v: int(max(0, min(255, v)))
    return clamp(r), clamp(g), clamp(b)


# Gaia's BP-RP color index -> effective temperature.
# Ballpark empirical fit; fine for color, don't cite it in a paper.
def bp_rp_to_temp(bp_rp):
    return 4600.0 * (1.0 / (0.92 * bp_rp + 1.7) + 1.0 / (0.92 * bp_rp + 0.62))


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 1

    src, dst = sys.argv[1], sys.argv[2]

    positions, colors, mags = [], [], []
    source_ids, bp_rps, parallaxes = [], [], []
    skipped = 0

    with open(src, newline="") as f:
        for row in csv.DictReader(f):
            try:
                parallax = float(row["parallax"])
                ra = float(row["ra"])
                dec = float(row["dec"])
                mag = float(row["phot_g_mean_mag"])
                bp_rp = float(row["bp_rp"])
                source_id = int(row["source_id"])
            except (ValueError, KeyError, TypeError):
                skipped += 1
                continue

            # Parallax in mas -> distance in parsecs. The ADQL cut should have
            # removed these already, but a stray <= 0 would blow up the divide.
            if parallax <= 0:
                skipped += 1
                continue
            dist_pc = 1000.0 / parallax

            ra_rad = math.radians(ra)
            dec_rad = math.radians(dec)
            cos_dec = math.cos(dec_rad)

            positions.append(dist_pc * cos_dec * math.cos(ra_rad))
            positions.append(dist_pc * cos_dec * math.sin(ra_rad))
            positions.append(dist_pc * math.sin(dec_rad))

            colors.extend(kelvin_to_rgb(bp_rp_to_temp(bp_rp)))
            mags.append(mag)

            # Split the 64-bit id into uint32 lo/hi halves.
            source_ids.append(source_id & 0xFFFFFFFF)
            source_ids.append((source_id >> 32) & 0xFFFFFFFF)
            bp_rps.append(bp_rp)
            parallaxes.append(parallax)

    count = len(mags)
    if count == 0:
        print(f"No usable rows in {src}. Check the CSV has Gaia column headers.")
        return 1

    with open(dst, "wb") as out:
        out.write(b"STAR")
        out.write(struct.pack("<III", 2, count, 0))
        out.write(struct.pack(f"<{count * 3}f", *positions))
        out.write(bytes(colors))
        out.write(struct.pack(f"<{count}f", *mags))
        out.write(struct.pack(f"<{count * 2}I", *source_ids))
        out.write(struct.pack(f"<{count}f", *bp_rps))
        out.write(struct.pack(f"<{count}f", *parallaxes))

    size_mb = (16 + count * 32) / 1e6
    print(f"Wrote {count:,} stars to {dst} ({size_mb:.1f} MB), skipped {skipped:,}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
