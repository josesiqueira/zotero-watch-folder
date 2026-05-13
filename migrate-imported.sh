#!/usr/bin/env bash
# Migrate scattered 'imported' subfolders into a single root-level imported/ folder.
# Usage: ./migrate-imported.sh /path/to/watch/folder [--dry-run]
#
# Before: watch/subfolder/imported/file.pdf
# After:  watch/imported/subfolder/file.pdf

set -euo pipefail

WATCH_ROOT="${1:-}"
DRY_RUN=false
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

if [[ -z "$WATCH_ROOT" ]]; then
    echo "Usage: $0 /path/to/watch/folder [--dry-run]"
    exit 1
fi

if [[ ! -d "$WATCH_ROOT" ]]; then
    echo "Error: '$WATCH_ROOT' is not a directory"
    exit 1
fi

ROOT_IMPORTED="$WATCH_ROOT/imported"
echo "Watch root:      $WATCH_ROOT"
echo "Target imported: $ROOT_IMPORTED"
$DRY_RUN && echo "(dry run — no files will be moved)"
echo ""

moved=0
skipped=0

# Find all 'imported' directories that are NOT the root-level one
while IFS= read -r -d '' imported_dir; do
    # Skip the root-level imported/ itself
    if [[ "$imported_dir" == "$ROOT_IMPORTED" ]]; then
        continue
    fi

    # Compute the path of imported_dir's parent relative to watch root
    parent_dir="$(dirname "$imported_dir")"
    rel_parent="${parent_dir#"$WATCH_ROOT"}"
    rel_parent="${rel_parent#/}"  # strip leading slash

    # Move each file inside this imported/ dir
    while IFS= read -r -d '' src_file; do
        # Path of the file relative to this imported/ dir
        rel_file="${src_file#"$imported_dir/"}"

        if [[ -z "$rel_parent" ]]; then
            dest_file="$ROOT_IMPORTED/$rel_file"
        else
            dest_file="$ROOT_IMPORTED/$rel_parent/$rel_file"
        fi

        dest_dir="$(dirname "$dest_file")"

        if $DRY_RUN; then
            echo "  MOVE: $src_file"
            echo "    ->  $dest_file"
        else
            mkdir -p "$dest_dir"
            if [[ -e "$dest_file" ]]; then
                echo "  SKIP (exists): $dest_file"
                ((skipped++)) || true
                continue
            fi
            if mv "$src_file" "$dest_file" 2>/dev/null; then
              echo "  Moved: $dest_file"
            else
              echo "  WARN (mv failed): $src_file"
              ((skipped++)) || true
              continue
            fi
        fi
        ((moved++)) || true
    done < <(find "$imported_dir" -type f -print0)

    # Remove empty imported/ subdir after migration
    if ! $DRY_RUN; then
        find "$imported_dir" -type d -empty -delete 2>/dev/null || true
    fi

done < <(find "$WATCH_ROOT" -type d -name 'imported' -print0)

echo ""
if $DRY_RUN; then
    echo "Dry run complete. $moved file(s) would be moved, $skipped skipped."
else
    echo "Done. $moved file(s) moved, $skipped skipped."
fi
