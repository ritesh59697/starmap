#!/usr/bin/env bash
# Download the Gravitational Wave Galaxy Catalogue (White et al. 2011) from VizieR.
#
#   ./tools/fetch_galaxies.sh [output.tsv] [max_dist_mpc]
#
# Real galaxies with measured distances, from the Local Group out to the Virgo
# Cluster. Small download (~1MB) compared to the Gaia pull.
#
# The catalog mixes in Milky Way globular clusters, tagged TT = -9. Those are not
# galaxies; build_galaxies.py filters them out.

set -euo pipefail

OUT="${1:-gwgc.tsv}"
MAXDIST="${2:-25}"

echo "Fetching galaxies out to ${MAXDIST} Mpc..."
curl -s --max-time 240 -G "https://vizier.cds.unistra.fr/viz-bin/asu-tsv" \
  --data-urlencode "-source=VII/267/gwgc" \
  --data-urlencode "-out=Name,RAJ2000,DEJ2000,Dist,Bmag,TT,a" \
  --data-urlencode "-out.max=20000" \
  --data-urlencode "Dist=0.01..${MAXDIST}" \
  --data-urlencode "-sort=Dist" \
  -o "${OUT}"

ROWS=$(grep -v "^#" "${OUT}" | grep -cv "^$" || true)
if [ "${ROWS}" -lt 10 ]; then
  echo "Fetch looks empty (${ROWS} lines). Check the VizieR service." >&2
  exit 1
fi

echo "Done: ${ROWS} lines in ${OUT}."
echo "Next: python3 tools/build_galaxies.py ${OUT} public/data/galaxies.bin"
