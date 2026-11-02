#!/bin/bash
# Passed as a literal command to the pinned image's /bin/bash, never mounted.
# Only shell builtins, GNU find, and GNU sha256sum run in the container.
set -u
set -o pipefail
export LC_ALL=C
roots=(/opt/oracle /usr/lib/jvm /usr/lib64/jvm /usr/java /usr/share/java /etc/oracle /etc/pki /usr/bin/java /bin/java)
visited_total=0
candidates=0
hashed_bytes=0
hashed_files=0
limit_hit=0

for root in "${roots[@]}"; do
  printf 'BEGIN\0%s\0' "$root"
  # Establish absence only after checking every parent is traversable/readable.
  parent=/
  remaining=${root#/}
  accessible=1
  absent=0
  symlink_parent=0
  while [[ "$remaining" == */* ]]; do
    part=${remaining%%/*}
    remaining=${remaining#*/}
    if [[ -L "$parent" ]]; then symlink_parent=1; break; fi
    if [[ ! -d "$parent" || ! -r "$parent" || ! -x "$parent" ]]; then
      accessible=0
      break
    fi
    parent=${parent%/}/$part
    if [[ ! -e "$parent" && ! -L "$parent" ]]; then
      absent=1
      break
    fi
  done
  if (( symlink_parent == 1 )) || [[ -L "$parent" ]]; then
    printf 'END\0%s\0symlink-ancestor\0%s\0' "$root" 0
    continue
  fi
  if (( absent == 1 )); then
    printf 'END\0%s\0absent\0%s\0' "$root" 0
    continue
  fi
  if (( accessible == 0 )) || [[ ! -d "$parent" || ! -r "$parent" || ! -x "$parent" ]]; then
    printf 'END\0%s\0unreadable\0%s\0' "$root" 0
    continue
  fi
  if [[ ! -e "$root" && ! -L "$root" ]]; then
    printf 'END\0%s\0absent\0%s\0' "$root" 0
    continue
  fi
  if (( limit_hit == 1 )); then
    printf 'END\0%s\0not-inspected\0%s\0' "$root" 0
    continue
  fi

  status=complete
  if [[ -L "$root" ]]; then status=symlink-root; fi
  visited=0
  # -P never follows candidate symlinks. Only verified read-only image mounts
  # can occur below these fixed roots; no host paths are mounted.
  exec {scan_fd}< <(/usr/bin/find -P "$root" -maxdepth 16 -printf '%d\0%y\0%m\0%s\0%p\0' 2>/dev/null)
  scan_pid=$!
  while (( visited_total < 100000 )) && IFS= read -r -d '' depth <&$scan_fd; do
    if ! IFS= read -r -d '' kind <&$scan_fd ||
       ! IFS= read -r -d '' mode <&$scan_fd ||
       ! IFS= read -r -d '' size <&$scan_fd ||
       ! IFS= read -r -d '' path <&$scan_fd; then
      status=scan-error
      break
    fi
    (( visited += 1, visited_total += 1 ))
    if [[ "$kind" == d && "$depth" == 16 ]]; then status=depth-limit; fi
    if (( ${#path} > 4096 )); then status=path-limit; continue; fi
    lower=${path,,}
    base=${lower##*/}
    category=
    # Conservative secret-material precedence: these paths are NEVER hashed.
    case "$lower" in
      *wallet*|*keystore*|*credential*|*password*|*secret*|*private*|*.p12|*.pfx|*.sso|*.jks|*.key|*.pem|*.der|*.crt|*.cer)
        category=wallet-metadata ;;
    esac
    if [[ -z "$category" ]]; then
      case "$base" in
        orapki|orapki.*|mkstore|mkstore.*|configtcps|configtcps.*|java|java.exe|oraclepki*.jar|osdt*.jar|ojpse*|jps*.jar|jce*.jar|jsafe*.jar)
          category=tool-candidate ;;
      esac
    fi
    if [[ -z "$category" ]]; then continue; fi
    (( candidates += 1 ))
    if (( candidates > 512 )); then status=candidate-limit; limit_hit=1; break; fi
    digest=
    hash_status=metadata-only-wallet
    if [[ "$category" == tool-candidate ]]; then
      hash_status=not-regular
      if [[ "$kind" == f && ! -L "$path" ]]; then
        hash_status=size-limit
        if (( size <= 33554432 )); then
          hash_status=budget-limit
          if (( hashed_files < 128 && hashed_bytes + size <= 134217728 )); then
            (( hashed_files += 1, hashed_bytes += size ))
            hash_status=read-error
            # stdin avoids sha256sum printing (or interpreting) a file name.
            if sum=$(/usr/bin/sha256sum < "$path" 2>/dev/null); then
              digest=${sum%% *}
              if [[ "$digest" =~ ^[a-f0-9]{64}$ ]]; then hash_status=sha256; else digest=; fi
            fi
          fi
        fi
        if [[ "$hash_status" != sha256 ]]; then status=hash-incomplete; fi
      fi
    fi
    printf 'FILE\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0%s\0' "$root" "$kind" "$mode" "$size" "$path" "$category" "$hash_status" "$digest"
  done
  if (( visited_total >= 100000 )); then status=entry-limit; limit_hit=1; fi
  exec {scan_fd}<&-
  # Closing the pipe stops a bounded/truncated find; wait captures traversal errors.
  if ! wait "$scan_pid"; then
    if [[ "$status" == complete ]]; then status=scan-error; fi
  fi
  printf 'END\0%s\0%s\0%s\0' "$root" "$status" "$visited"
done
printf 'DONE\0'
