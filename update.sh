#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_REPOSITORY="https://github.com/PxTicks/vlo.git"
DEFAULT_BRANCH="main"
BACKUP_ROOT="$SCRIPT_DIR/.vlo-update-backups"
STAGE_DIR=""
BACKUP_DIR=""
CONVERSION_IN_PROGRESS=0
CONFIRM_ZIP_CONVERSION=0
INSTALL_ARGS=()
PREVIEW_LIMIT=20

info()  { printf '\033[1;34m[INFO]\033[0m  %s\n' "$*"; }
error() { printf '\033[1;31m[ERROR]\033[0m %s\n' "$*" >&2; }

usage() {
    cat <<'USAGE'
Usage: ./update.sh [--confirm-zip-conversion] [installer options]

Fetch the latest VLO source, then rerun install.sh to update dependencies and
rebuild the frontend. Installer options such as --profiles and --update-node
are passed through unchanged.

Tracked local changes must be committed or removed before updating a Git
checkout.

A folder downloaded as a GitHub ZIP is converted into a Git checkout. If that
would replace or move any local file, the updater lists those files and asks
first; each one is saved under .vlo-update-backups/ before it is touched.

  --confirm-zip-conversion  Approve those changes without asking. Required
                            when the updater cannot prompt.
USAGE
}

cleanup() {
    local status=$?

    if [ -n "$STAGE_DIR" ] && [ -d "$STAGE_DIR" ]; then
        rm -rf -- "$STAGE_DIR"
        rmdir -- "$BACKUP_ROOT" 2>/dev/null || true
    fi
    if [ "$status" -ne 0 ] && [ "$CONVERSION_IN_PROGRESS" -eq 1 ]; then
        if [ -d "$BACKUP_DIR" ]; then
            error "The ZIP conversion stopped partway. Local files it had already set aside are in ${BACKUP_DIR}; its MANIFEST.txt lists them."
        else
            error "The ZIP conversion stopped partway. None of the local files had been replaced; rerun the updater."
        fi
    fi
}
trap cleanup EXIT

stage_git() {
    git --git-dir="$STAGE_DIR/repository/.git" --work-tree="$SCRIPT_DIR" "$@"
}

# Print the first entries of a NUL-separated list, then how many were left out.
preview_list() {
    local title="$1" list="$2" count=0 path

    [ -s "$list" ] || return 0
    printf '\n%s\n' "$title"
    while IFS= read -r -d '' path; do
        count=$((count + 1))
        if [ "$count" -le "$PREVIEW_LIMIT" ]; then
            printf '    %s\n' "$path"
        fi
    done < "$list"
    if [ "$count" -gt "$PREVIEW_LIMIT" ]; then
        printf '    ... and %d more\n' "$((count - PREVIEW_LIMIT))"
    fi
}

manifest_section() {
    local title="$1" list="$2" path

    [ -s "$list" ] || return 0
    printf '\n%s\n' "$title"
    while IFS= read -r -d '' path; do
        printf '    %s\n' "$path"
    done < "$list"
}

# Move a file or folder into the backup at the same relative path, then remove
# any folders the move emptied so stale directory trees do not linger.
move_aside() {
    local path="$1" parent

    [ -e "$path" ] || [ -L "$path" ] || return 0
    mkdir -p -- "$BACKUP_DIR/$(dirname -- "$path")"
    mv -- "$path" "$BACKUP_DIR/$path"
    parent="$(dirname -- "$path")"
    while [ "$parent" != "." ] && rmdir -- "$parent" 2>/dev/null; do
        parent="$(dirname -- "$parent")"
    done
}

convert_zip_installation() {
    local repository="${VLO_UPDATE_REPOSITORY:-$DEFAULT_REPOSITORY}"
    local branch="${VLO_UPDATE_BRANCH:-$DEFAULT_BRANCH}"
    local plan status path prefix rest record_source record_line record_pattern
    local answer ignore_status item skip
    local in_the_way_items=()

    mkdir -p -- "$BACKUP_ROOT"
    # Staging inside the installation keeps the final .git move a rename.
    STAGE_DIR="$(mktemp -d "$BACKUP_ROOT/.stage.XXXXXX")"
    plan="$STAGE_DIR/plan"
    mkdir -p -- "$plan" "$STAGE_DIR/ignore-rules"

    info "This VLO folder is not a Git checkout; preparing to convert the ZIP installation..."
    git clone --depth 1 --branch "$branch" --no-checkout "$repository" "$STAGE_DIR/repository"
    stage_git read-tree HEAD

    : > "$plan/overwritten.all"
    : > "$plan/in-the-way.all"
    : > "$plan/linked.all"
    : > "$plan/leftovers"

    # 1. Tracked paths whose local copy differs from the fetched version. A path
    #    reported missing may really be hidden behind a file or a symbolic link
    #    in one of its parent folders, or be occupied by a folder.
    stage_git diff --name-status -z --no-renames |
        while IFS= read -r -d '' status && IFS= read -r -d '' path; do
            case "$status" in
                D)
                    prefix=""
                    rest="$path"
                    while :; do
                        case "$rest" in */*) ;; *) break ;; esac
                        prefix="${prefix:+$prefix/}${rest%%/*}"
                        rest="${rest#*/}"
                        if [ -L "$prefix" ]; then
                            printf '%s\0' "$prefix" >> "$plan/linked.all"
                            continue 2
                        elif [ ! -e "$prefix" ]; then
                            continue 2
                        elif [ ! -d "$prefix" ]; then
                            printf '%s\0' "$prefix" >> "$plan/in-the-way.all"
                            continue 2
                        fi
                    done
                    if [ -e "$path" ] || [ -L "$path" ]; then
                        printf '%s\0' "$path" >> "$plan/in-the-way.all"
                    fi
                    ;;
                *)
                    printf '%s\0' "$path" >> "$plan/overwritten.all"
                    ;;
            esac
        done
    sort -zu "$plan/overwritten.all" > "$plan/overwritten"
    sort -zu "$plan/in-the-way.all" > "$plan/in-the-way"
    sort -zu "$plan/linked.all" > "$plan/linked"

    # 2. Refuse rather than replace a linked folder with a real one: the data
    #    behind the link would survive, but VLO would stop seeing it.
    if [ -s "$plan/linked" ]; then
        error "These folders are symbolic links, but the new version tracks files inside them:"
        while IFS= read -r -d '' path; do
            printf '    %s\n' "$path" >&2
        done < "$plan/linked"
        error "Converting would replace each link with an empty folder. Move their contents into normal folders, then rerun the updater. Nothing was changed."
        exit 1
    fi

    # 3. Files the fetched version does not track. Anything ignored by either
    #    the ZIP's own rules or the fetched version's rules is local data and
    #    stays put; the rest is source the new version no longer has.
    stage_git ls-tree -r -z --name-only HEAD |
        while IFS= read -r -d '' path; do
            case "$path" in
                .gitignore|*/.gitignore)
                    mkdir -p -- "$STAGE_DIR/ignore-rules/$(dirname -- "$path")"
                    stage_git show "HEAD:$path" > "$STAGE_DIR/ignore-rules/$path"
                    ;;
            esac
        done
    stage_git ls-files --others --exclude-standard --exclude=/.vlo-update-backups/ -z \
        > "$plan/candidates"
    ignore_status=0
    git -C "$STAGE_DIR/ignore-rules" --git-dir="$STAGE_DIR/repository/.git" \
        --work-tree="$STAGE_DIR/ignore-rules" \
        check-ignore --no-index --stdin -z -v -n \
        < "$plan/candidates" > "$plan/candidate-rules" || ignore_status=$?
    if [ "$ignore_status" -gt 1 ]; then
        error "Git could not evaluate the new version's ignore rules."
        exit 1
    fi

    while IFS= read -r -d '' item; do
        in_the_way_items+=("$item")
    done < "$plan/in-the-way"
    while IFS= read -r -d '' record_source \
        && IFS= read -r -d '' record_line \
        && IFS= read -r -d '' record_pattern \
        && IFS= read -r -d '' path; do
        case "$record_pattern" in
            ""|"!"*) ;;
            *) continue ;;
        esac
        skip=0
        for item in ${in_the_way_items[@]+"${in_the_way_items[@]}"}; do
            case "$path" in "$item"/*) skip=1; break ;; esac
        done
        [ "$skip" -eq 1 ] || printf '%s\0' "${path%/}" >> "$plan/leftovers"
    done < "$plan/candidate-rules"

    # 4. Nothing local changes when the ZIP matches the fetched version, so
    #    only ask when a file would be replaced or moved.
    BACKUP_DIR="$BACKUP_ROOT/zip-import-$(date -u +%Y%m%dT%H%M%SZ)"
    if [ -s "$plan/overwritten" ] || [ -s "$plan/in-the-way" ] || [ -s "$plan/leftovers" ]; then
        printf '\n'
        info "Converting this folder to a Git checkout will change these local files:"
        preview_list "Differ from the new version (a copy is saved, then the file is replaced):" \
            "$plan/overwritten"
        preview_list "In the way of new files (moved into the backup):" "$plan/in-the-way"
        preview_list "No longer part of VLO (moved into the backup):" "$plan/leftovers"
        printf '\nEverything listed is saved under %s\n\n' "${BACKUP_DIR#"$SCRIPT_DIR"/}"

        if [ "$CONFIRM_ZIP_CONVERSION" -eq 0 ]; then
            if [ ! -t 0 ]; then
                error "Rerun the updater from a terminal to approve these changes, or pass --confirm-zip-conversion. Nothing was changed."
                exit 1
            fi
            read -r -p "Continue? [y/N] " answer
            case "$answer" in
                y|Y|yes|YES|Yes) ;;
                *)
                    info "Update cancelled. Nothing was changed."
                    exit 1
                    ;;
            esac
        fi

        CONVERSION_IN_PROGRESS=1
        mkdir -p -- "$BACKUP_DIR"
        {
            printf 'Saved by update.sh on %s while converting a ZIP installation into a\n' \
                "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
            printf 'Git checkout of %s (%s).\n' "$repository" "$branch"
            printf 'Each entry is stored at its original path relative to the VLO folder.\n'
            manifest_section "Copied, then replaced by the new version:" "$plan/overwritten"
            manifest_section "Moved aside because it was in the way of new files:" "$plan/in-the-way"
            manifest_section "Moved aside because VLO no longer includes it:" "$plan/leftovers"
        } > "$BACKUP_DIR/MANIFEST.txt"

        while IFS= read -r -d '' path; do
            mkdir -p -- "$BACKUP_DIR/$(dirname -- "$path")"
            cp -pRP -- "$path" "$BACKUP_DIR/$path"
        done < "$plan/overwritten"
        while IFS= read -r -d '' path; do
            move_aside "$path"
        done < "$plan/in-the-way"
        while IFS= read -r -d '' path; do
            move_aside "$path"
        done < "$plan/leftovers"
    fi

    CONVERSION_IN_PROGRESS=1
    stage_git reset --hard --quiet HEAD
    mv -- "$STAGE_DIR/repository/.git" "$SCRIPT_DIR/.git"
    CONVERSION_IN_PROGRESS=0

    if [ -d "$BACKUP_DIR" ]; then
        info "Saved the replaced and moved files to ${BACKUP_DIR}"
    fi
    info "Converted this folder to a Git checkout tracking ${repository} (${branch})."
}

for argument in "$@"; do
    case "$argument" in
        -h|--help)
            usage
            exit 0
            ;;
        --confirm-zip-conversion) CONFIRM_ZIP_CONVERSION=1 ;;
        *) INSTALL_ARGS+=("$argument") ;;
    esac
done

info "VLO Updater"
printf '\n'

if ! command -v git >/dev/null 2>&1 || ! git --version >/dev/null 2>&1; then
    error "Git is required to update VLO. Install it from https://git-scm.com/downloads, then rerun this script."
    exit 1
fi

if [ ! -f "$SCRIPT_DIR/install.sh" ] || [ ! -f "$SCRIPT_DIR/package.json" ]; then
    error "This script must remain in the root of a VLO installation."
    exit 1
fi

cd "$SCRIPT_DIR"

if [ -e "$SCRIPT_DIR/.git" ]; then
    if ! git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
        error "The .git entry exists but is not a usable Git checkout."
        exit 1
    fi

    if [ -n "$(git -C "$SCRIPT_DIR" status --porcelain --untracked-files=no)" ]; then
        error "Tracked source files have local changes. Commit or remove them before updating."
        git -C "$SCRIPT_DIR" status --short --untracked-files=no >&2
        exit 1
    fi

    info "Fetching updates for the existing Git checkout..."
    if ! git -C "$SCRIPT_DIR" pull --ff-only; then
        error "Git could not fast-forward this checkout. Resolve its branch or upstream configuration, then rerun the updater."
        exit 1
    fi
else
    convert_zip_installation
fi

printf '\n'
info "Rebuilding VLO with the updated installer..."
"$SCRIPT_DIR/install.sh" ${INSTALL_ARGS[@]+"${INSTALL_ARGS[@]}"}
