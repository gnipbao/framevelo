#!/bin/bash
run(){ label=$1; shift; /usr/bin/time -l ffmpeg -hide_banner -v error -y "$@" 2> t.txt; r=$(awk '/real/{print $1}' t.txt); u=$(awk '/real/{print $3}' t.txt); s=$(awk '/real/{print $5}' t.txt); m=$(awk '/maximum resident/{printf "%.0f", $1/1048576}' t.txt); echo "$label | wall ${r}s | cpu $(echo "$u+$s"|bc)s | maxRSS ${m}MB"; }
for RES in 1920x1080 3840x2160; do
SRC=(-f lavfi -i "testsrc2=size=$RES:rate=30:duration=10,format=bgra")
run "$RES source-only(null)" "${SRC[@]}" -f null -
run "$RES libx264 medium crf18" "${SRC[@]}" -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p o.mp4
run "$RES libx264 veryfast crf18" "${SRC[@]}" -c:v libx264 -preset veryfast -crf 18 -pix_fmt yuv420p o.mp4
run "$RES h264_videotoolbox q65" "${SRC[@]}" -c:v h264_videotoolbox -q:v 65 -pix_fmt nv12 o.mp4
run "$RES hevc_videotoolbox q65" "${SRC[@]}" -c:v hevc_videotoolbox -q:v 65 -pix_fmt nv12 -tag:v hvc1 o.mp4
run "$RES prores_videotoolbox" "${SRC[@]}" -c:v prores_videotoolbox -profile:v 2 o.mov
done
