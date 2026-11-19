#!/bin/sh
set -eu

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  printf '사용법: sh scripts/release.sh v0.1.0 [linux/amd64]\n' >&2
  exit 2
fi

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)
version=$1
if [ "${#version}" -gt 128 ] || ! printf '%s\n' "$version" | grep -Eq '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
  printf '릴리스 버전은 v0.1.0 형식이어야 합니다.\n' >&2
  exit 2
fi
if ! revision=$(git -C "$root" rev-parse --verify --quiet "refs/tags/$version^{commit}"); then
  printf '커밋을 가리키는 Git 태그 %s가 필요합니다.\n' "$version" >&2
  exit 2
fi

platform=${2:-${DOCKER_DEFAULT_PLATFORM:-}}
if [ -z "$platform" ]; then
  platform=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
fi
case "$platform" in
  linux/*) architecture=${platform#linux/} ;;
  *) architecture= ;;
esac
case "$architecture" in
  ''|*[!a-z0-9]*)
    printf '플랫폼은 linux/amd64 또는 linux/arm64와 같은 형식이어야 합니다.\n' >&2
    exit 2 ;;
esac

releases=$root/build/releases
output=$releases/$version-linux-$architecture
lock=$releases/.$version.lock
mkdir -p "$releases"
if ! mkdir "$lock"; then
  printf '%s 릴리스를 이미 빌드 중입니다.\n' "$version" >&2
  exit 1
fi
trap 'rm -r "$lock"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ -e "$output" ]; then
  printf '이미 패키지가 있습니다. %s\n' "$output" >&2
  exit 1
fi

source=$lock/source
bundle=$lock/bundle
mkdir "$source" "$bundle"
git -C "$root" archive --format=tar --output="$lock/source.tar" "$revision"
tar -xf "$lock/source.tar" -C "$source"

export HERD_VERSION="$version" HERD_REVISION="$revision" HERD_IMAGE_PREFIX=herd DOCKER_DEFAULT_PLATFORM="$platform"
printf 'HERD_VERSION=%s\nHERD_IMAGE_PREFIX=%s\nCOMPOSE_PROJECT_NAME=herd\n' "$HERD_VERSION" "$HERD_IMAGE_PREFIX" > "$bundle/release.env"
cp "$source/compose.yaml" "$bundle/compose.yaml"
docker compose --env-file "$bundle/release.env" -f "$source/compose.yaml" build api web

api_image=herd-api:$version
web_image=herd-web:$version
for image in "$api_image" "$web_image"; do
  actual=$(docker image inspect --format '{{.Os}}/{{.Architecture}} {{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
  if [ "$actual" != "$platform $version $revision" ]; then
    printf '%s 이미지의 플랫폼, 버전 또는 커밋이 릴리스와 일치하지 않습니다.\n' "$image" >&2
    exit 1
  fi
done
docker image save -o "$lock/images.tar" "$api_image" "$web_image"
gzip -c "$lock/images.tar" > "$bundle/images.tar.gz"
printf 'version=%s\nrevision=%s\nplatform=%s\n' "$version" "$revision" "$platform" > "$bundle/release.txt"
mv "$bundle" "$output"
printf '릴리스 패키지 %s\n' "$output"
