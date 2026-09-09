#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "Использование: $0 <аудиофайл> [число повторов]" >&2
  exit 2
fi

source_file=$1
repeats=${2:-3}

test -r "$source_file" || { echo "Файл недоступен для чтения" >&2; exit 1; }
case "$repeats" in *[!0-9]*|'') echo "Число повторов должно быть целым" >&2; exit 2;; esac
[ "$repeats" -ge 1 ] || { echo "Число повторов должно быть больше нуля" >&2; exit 2; }
command -v ffmpeg >/dev/null
command -v ffprobe >/dev/null
export LC_ALL=C

temporary=$(mktemp -d /tmp/family-music-benchmark.XXXXXX)
trap 'rm -rf "$temporary"' EXIT INT TERM

duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$source_file")
printf 'duration_seconds\t%s\n' "$duration"
printf 'profile\trun\telapsed_seconds\tmax_rss_kib\toutput_bytes\trealtime_factor\n'

for bitrate in 96 192; do
  run=1
  while [ "$run" -le "$repeats" ]; do
    output="$temporary/aac_${bitrate}_${run}.m4a"
    timing="$temporary/aac_${bitrate}_${run}.time"
    ffmpeg -nostdin -hide_banner -nostats -benchmark -loglevel info -y \
      -i "$source_file" -map 0:a:0 -vn -c:a aac -b:a "${bitrate}k" \
      -movflags +faststart -f mp4 "$output" 2>"$timing"
    elapsed=$(sed -n 's/^bench: .*rtime=\([0-9.]*\)s.*/\1/p' "$timing" | tail -1)
    memory=$(sed -n 's/^bench: maxrss=\([0-9]*\)KiB.*/\1/p' "$timing" | tail -1)
    test -n "$elapsed"
    test -n "$memory"
    size=$(stat -c %s "$output")
    factor=$(awk -v duration="$duration" -v elapsed="$elapsed" 'BEGIN {if (elapsed > 0) printf "%.2f", duration/elapsed; else print "inf"}')
    printf 'aac_%s\t%s\t%s\t%s\t%s\t%sx\n' "$bitrate" "$run" "$elapsed" "$memory" "$size" "$factor"
    run=$((run + 1))
  done
done
