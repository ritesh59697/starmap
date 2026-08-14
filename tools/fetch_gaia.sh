#!/usr/bin/env bash
# Download real Gaia DR3 stars via ESA's public TAP service.
#
#   ./tools/fetch_gaia.sh [output.csv] [max_g_mag]
#
# No login required. The sync endpoint caps out well below what we want, so this
# submits an async job, polls until it finishes, then downloads the result.
#
# NOTE: the archive enforces a 3,000,000 row ceiling on anonymous async jobs.
# A G<13 cut would naturally return ~4M, so it comes back truncated at 3M. That
# is not an error -- you just get the 3M brightest matching rows.

set -euo pipefail

OUT="${1:-gaia_dr3.csv}"
MAXMAG="${2:-13}"
BASE="https://gea.esac.esa.int/tap-server/tap"

QUERY="SELECT source_id, ra, dec, parallax, phot_g_mean_mag, bp_rp
FROM gaiadr3.gaia_source
WHERE parallax_over_error > 10
  AND ruwe < 1.4
  AND phot_g_mean_mag < ${MAXMAG}
  AND bp_rp IS NOT NULL"

echo "Submitting job (G < ${MAXMAG})..."
LOCATION=$(curl -s -X POST "${BASE}/async" \
  --data-urlencode "REQUEST=doQuery" \
  --data-urlencode "LANG=ADQL" \
  --data-urlencode "FORMAT=csv" \
  --data-urlencode "PHASE=RUN" \
  --data-urlencode "QUERY=${QUERY}" \
  -D - -o /dev/null | awk '/^[Ll]ocation:/ {print $2}' | tr -d '\r')

if [ -z "${LOCATION}" ]; then
  echo "Failed to submit job." >&2
  exit 1
fi
echo "Job: ${LOCATION}"

while true; do
  PHASE=$(curl -s "${LOCATION}/phase")
  echo "  phase: ${PHASE}"
  case "${PHASE}" in
    COMPLETED) break ;;
    ERROR|ABORTED)
      echo "Job failed." >&2
      curl -s "${LOCATION}" >&2
      exit 1
      ;;
  esac
  sleep 15
done

echo "Downloading to ${OUT} (this is a few hundred MB)..."
curl -# -o "${OUT}" "${LOCATION}/results/result"

echo "Done: $(wc -l < "${OUT}") lines."
echo "Next: python3 tools/build_stars.py ${OUT} public/data/stars.bin"
