#!/usr/bin/env python3
"""Convert the Gravitational Wave Galaxy Catalogue into the intergalactic tier.

    python3 tools/build_galaxies.py gwgc.tsv public/data/galaxies.bin

Source: VII/267/gwgc (White et al. 2011), fetched by tools/fetch_galaxies.sh.
Real galaxies with measured distances, from the Local Group out to ~25 Mpc --
which covers the Virgo Cluster at ~16.5 Mpc.

These are REAL objects with real names and distances, unlike the procedural
Milky Way backdrop. Every one is clickable and its numbers come from the catalog.

Output format 'GLXY' v1, positions in MEGAPARSECS (not pc -- this tier is 6
orders of magnitude larger than the stellar one):

    magic   'GLXY'          4 bytes
    version uint32          1
    count   uint32          N
    nameLen uint32          total bytes of the name blob
    pos     float32[N*3]    x,y,z in Mpc, Milky Way at origin
    color   uint8[N*3]      r,g,b by morphological type
    size    float32[N]      relative render size
    dist    float32[N]      distance in Mpc
    bmag    float32[N]      B magnitude (NaN when absent)
    ttype   float32[N]      de Vaucouleurs morphological type
    nameOff uint32[N]       byte offset of each name in the blob
    names   utf8 bytes      newline-free, concatenated
"""

import math
import struct
import sys

# The catalog uses survey designations, so the famous galaxies arrive with names
# nobody recognises. Map the well-known ones to what people actually call them.
COMMON_NAMES = {
    "NGC0224": "Andromeda (M31)",
    "NGC0598": "Triangulum (M33)",
    "ESO056-115": "Large Magellanic Cloud",
    "NGC0292": "Small Magellanic Cloud",
    "NGC6822": "Barnard's Galaxy",
    "NGC5128": "Centaurus A",
    "NGC0253": "Sculptor Galaxy",
    "NGC5194": "Whirlpool (M51)",
    "NGC4594": "Sombrero (M104)",
    "NGC3031": "Bode's Galaxy (M81)",
    "NGC3034": "Cigar Galaxy (M82)",
    "NGC4472": "M49 (Virgo)",
    "NGC4486": "M87 (Virgo)",
    "NGC4321": "M100 (Virgo)",
    "NGC1068": "M77",
    "NGC0205": "M110",
    "NGC0221": "M32",
    "IC0010": "IC 10",
    "IC1613": "IC 1613",
    "UGC12613": "Pegasus Dwarf",
    "ESO351-030": "Sculptor Dwarf",
    "UGC10822": "Draco Dwarf",
    "UGC09749": "Ursa Minor Dwarf",
    "NGC6715": "Sagittarius Dwarf",
    "NGC0185": "NGC 185",
    "NGC0147": "NGC 147",
}


# de Vaucouleurs T-type -> colour. Ellipticals are old and red, spirals bluer,
# irregulars bluest. TT = -9 marks globular clusters, which we drop entirely.
def ttype_color(tt):
    if tt is None or tt != tt:  # NaN
        return (200, 200, 210)
    if tt < -3.5:
        return (255, 214, 170)   # elliptical
    if tt < 0.5:
        return (255, 236, 210)   # lenticular
    if tt < 5.0:
        return (215, 232, 255)   # early spiral
    if tt < 9.0:
        return (170, 205, 255)   # late spiral
    return (150, 190, 255)       # irregular


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        return 1

    src, dst = sys.argv[1], sys.argv[2]

    positions, colors, sizes = [], [], []
    dists, bmags, ttypes, names = [], [], [], []
    skipped_globular = 0
    skipped_bad = 0

    with open(src, encoding="utf-8", errors="replace") as f:
        rows = []
        for line in f:
            line = line.rstrip("\n")
            if not line or line.startswith("#"):
                continue
            rows.append(line)

    # VizieR TSV: header, units, dashes, then data.
    if len(rows) < 4:
        print(f"{src} has no data rows -- did the fetch fail?")
        return 1
    header = rows[0].split("\t")
    col = {name.strip(): i for i, name in enumerate(header)}
    for required in ("Name", "RAJ2000", "DEJ2000", "Dist"):
        if required not in col:
            print(f"Missing column {required!r}. Got: {list(col)}")
            return 1

    for line in rows[3:]:
        parts = line.split("\t")
        if len(parts) < len(header):
            skipped_bad += 1
            continue

        def get(name):
            raw = parts[col[name]].strip() if name in col else ""
            return raw

        try:
            ra = float(get("RAJ2000"))
            dec = float(get("DEJ2000"))
            dist = float(get("Dist"))
        except ValueError:
            skipped_bad += 1
            continue

        if dist <= 0:
            skipped_bad += 1
            continue

        try:
            tt = float(get("TT"))
        except ValueError:
            tt = float("nan")

        # TT = -9 is a globular cluster inside the Milky Way, not a galaxy.
        # Including them here would misrepresent what this tier shows.
        if tt == -9.0:
            skipped_globular += 1
            continue

        try:
            bmag = float(get("Bmag"))
        except ValueError:
            bmag = float("nan")

        try:
            diam = float(get("a"))  # major axis, arcmin
        except ValueError:
            diam = float("nan")

        raw_name = get("Name") or "unnamed"

        # A placeholder row for the Milky Way's own centre. We render the Milky
        # Way as an actual galaxy, so a marker for it here would be a duplicate.
        if raw_name == "GALCENTER":
            skipped_bad += 1
            continue

        name = COMMON_NAMES.get(raw_name, raw_name)

        ra_rad = math.radians(ra)
        dec_rad = math.radians(dec)
        cos_dec = math.cos(dec_rad)

        positions.append(dist * cos_dec * math.cos(ra_rad))
        positions.append(dist * cos_dec * math.sin(ra_rad))
        positions.append(dist * math.sin(dec_rad))

        colors.extend(ttype_color(tt))

        # Physical size from angular diameter and distance, when available;
        # otherwise fall back to brightness. Purely for render scale.
        if diam == diam and diam > 0:
            size = math.radians(diam / 60.0) * dist  # Mpc across
        elif bmag == bmag:
            size = max(0.002, 0.05 * (10 ** (-0.1 * (bmag - 10))))
        else:
            size = 0.01
        sizes.append(max(0.002, min(size, 0.5)))

        dists.append(dist)
        bmags.append(bmag)
        ttypes.append(tt)
        names.append(name)

    count = len(dists)
    if count == 0:
        print("No galaxies survived filtering.")
        return 1

    blob = bytearray()
    offsets = []
    for n in names:
        offsets.append(len(blob))
        blob.extend(n.encode("utf-8"))
    offsets.append(len(blob))  # sentinel so the last name's length is derivable

    with open(dst, "wb") as out:
        out.write(b"GLXY")
        out.write(struct.pack("<III", 1, count, len(blob)))
        out.write(struct.pack(f"<{count * 3}f", *positions))
        out.write(bytes(colors))
        out.write(struct.pack(f"<{count}f", *sizes))
        out.write(struct.pack(f"<{count}f", *dists))
        out.write(struct.pack(f"<{count}f", *bmags))
        out.write(struct.pack(f"<{count}f", *ttypes))
        out.write(struct.pack(f"<{count + 1}I", *offsets))
        out.write(bytes(blob))

    print(
        f"Wrote {count:,} galaxies to {dst} "
        f"(skipped {skipped_globular:,} globular clusters, {skipped_bad:,} bad rows)."
    )
    near = sum(1 for d in dists if d < 1.5)
    print(f"  {near} within 1.5 Mpc (Local Group), max {max(dists):.1f} Mpc")
    return 0


if __name__ == "__main__":
    sys.exit(main())
