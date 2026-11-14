#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
if [ -x bin/merobiman ]; then
 exec ./bin/merobiman -data data/gistemp.nc.gz "$@"
elif [ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ]; then
 chmod +x bin/merobiman-linux-amd64
 exec ./bin/merobiman-linux-amd64 -data data/gistemp.nc.gz "$@"
else
 echo 'Build for your operating system first; see README.md.' >&2
 exit 1
fi
