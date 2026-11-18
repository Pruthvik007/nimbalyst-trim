#!/bin/bash
# Records Nimbalyst's memory and CPU into usage.csv.
set -euo pipefail

if [[ $# -ne 1 || $1 == -h || $1 == --help ]]; then
  cat <<'EOF'
usage: ./usage.sh <label>

Samples CPU of the Nimbalyst app processes every 2 s for 30 s, then reads their
memory footprint (the figure Activity Monitor shows) and appends one row to
usage.csv in NIMBALYST_TRIM_DATA (default: ~/Library/Application Support/nimbalyst-trim).
Claude and Codex agent processes are left out.
EOF
  exit 0
fi

label=$1
data_dir=${NIMBALYST_TRIM_DATA:-"$HOME/Library/Application Support/nimbalyst-trim"}
mkdir -p "$data_dir"
csv="$data_dir/usage.csv"

nimbalyst_pids() {
  ps -axo pid=,command= | grep -E '/Nimbalyst\.app/Contents/(MacOS|Frameworks)/' | grep -v grep | awk '{print $1}'
}

pids=$(nimbalyst_pids)
[[ -z $pids ]] && { echo "Nimbalyst is not running" >&2; exit 1; }

cpu_samples=()
for _ in $(seq 15); do
  cpu_samples+=("$(ps -o %cpu= -p "$(nimbalyst_pids | paste -sd, -)" | awk '{s+=$1} END {printf "%.1f", s}')")
  sleep 2
done
avg_cpu=$(printf '%s\n' "${cpu_samples[@]}" | awk '{s+=$1} END {printf "%.1f", s/NR}')
max_cpu=$(printf '%s\n' "${cpu_samples[@]}" | sort -n | tail -1)

# footprint prints sizes as "<n> MB" or "<n> GB"; to_mb normalises both.
footprint_report=$(footprint $(nimbalyst_pids) 2>/dev/null)
read -r main_mb main_peak_mb renderers_mb total_mb < <(awk '
  function to_mb(n, unit) { return unit == "GB" ? n * 1024 : (unit == "KB" ? n / 1024 : n) }
  /^Nimbalyst \[[0-9]+\]:/ { in_main = 1; in_renderer = 0 }
  /^Nimbalyst Helper/ { in_main = 0; in_renderer = /\(Renderer\)/ }
  /phys_footprint:/ { if (in_main) main = to_mb($2, $3); if (in_renderer) renderers += to_mb($2, $3) }
  /phys_footprint_peak:/ && in_main { peak = to_mb($2, $3) }
  /^Summary Footprint:/ { total = to_mb($3, $4) }
  END { printf "%d %d %d %d\n", main, peak, renderers, total }
' <<<"$footprint_report")

[[ -f $csv ]] || echo "time,label,main_mb,main_peak_mb,renderers_mb,total_mb,avg_cpu_pct,max_cpu_pct,processes" >"$csv"
row="$(date '+%Y-%m-%d %H:%M:%S'),$label,$main_mb,$main_peak_mb,$renderers_mb,$total_mb,$avg_cpu,$max_cpu,$(nimbalyst_pids | wc -l | tr -d ' ')"
echo "$row" >>"$csv"
column -s, -t "$csv"
