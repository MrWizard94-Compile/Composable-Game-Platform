#!/bin/sh
# Download the pinned Study 013 CLI tools and verify their sha256.
set -eu
dest="${CGP_WIT_TOOLS:-/tmp/cgp-wit-tools/bin}"
work="${CGP_WIT_WORK:-$(dirname "$dest")/src}"
mkdir -p "$dest" "$work"

install_one() {
  name="$1"
  folder="$2"
  url="$3"
  file="$4"
  sum="$5"
  if [ -x "$dest/$name" ]; then
    return 0
  fi
  curl -fsSL "$url" -o "$work/$file"
  echo "$sum  $work/$file" | sha256sum -c -
  tar --no-same-owner -xf "$work/$file" -C "$work"
  install -m 0755 "$work/$folder/$name" "$dest/$name"
}

install_one wasmtime \
  "wasmtime-v50.0.3-x86_64-linux" \
  "https://github.com/bytecodealliance/wasmtime/releases/download/v50.0.3/wasmtime-v50.0.3-x86_64-linux.tar.xz" \
  "wasmtime.tar.xz" \
  "c59133a9334e96eaca5e26f0d4c35199bfe43ab34049aa254ef4b47af1361476"
install_one wasm-tools \
  "wasm-tools-1.263.0-x86_64-linux" \
  "https://github.com/bytecodealliance/wasm-tools/releases/download/v1.263.0/wasm-tools-1.263.0-x86_64-linux.tar.gz" \
  "wasm-tools.tar.gz" \
  "21c036c1740a0552124c79c6e2170cb61c5b016005671a6d5bc06cf642165431"
install_one wit-bindgen \
  "wit-bindgen-0.63.0-x86_64-linux" \
  "https://github.com/bytecodealliance/wit-bindgen/releases/download/v0.63.0/wit-bindgen-0.63.0-x86_64-linux.tar.gz" \
  "wit-bindgen.tar.gz" \
  "bf4efe883ab70d34a4740253911dda20caf895d58a003af58369506b04684cbe"

"$dest/wasmtime" --version
"$dest/wasm-tools" --version
"$dest/wit-bindgen" --version
