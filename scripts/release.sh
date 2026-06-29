#!/usr/bin/env bash
#
# release.sh — bump the version, commit, push, and push a version tag.
#
# Pushing the tag triggers the GitHub Actions "Release" workflow
# (.github/workflows/release.yml), which builds, attests (signed provenance),
# and publishes the GitHub release with main.js, manifest.json, and styles.css
# attached. This script does NOT build or create the release itself — CI does.
#
# Usage:
#   ./scripts/release.sh <patch|minor|major|X.Y.Z> [-y]
#
#   patch|minor|major   bump the current version by that semver level
#   X.Y.Z               set this exact version
#   -y, --yes           skip the confirmation prompt
#
# You supply the bump level and the release notes (release-notes/<version>.md).
#
# NOTE: this script runs git commit / push / tag on your behalf.
#
set -euo pipefail

RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; BLU=$'\033[34m'; RST=$'\033[0m'
info() { printf '%s==>%s %s\n' "$GRN" "$RST" "$*"; }
step() { printf '%s ->%s %s\n' "$BLU" "$RST" "$*"; }
warn() { printf '%s !!%s %s\n' "$YEL" "$RST" "$*" >&2; }
die()  { printf '%sERROR:%s %s\n' "$RED" "$RST" "$*" >&2; exit 1; }
usage() { die "usage: ./scripts/release.sh <patch|minor|major|X.Y.Z> [-y]"; }

cd "$(dirname "$0")/.."

# --- parse args ------------------------------------------------------------
LEVEL=""; ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    -y|--yes) ASSUME_YES=1 ;;
    patch|minor|major) LEVEL="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) LEVEL="$arg" ;;
    *) usage ;;
  esac
done
[ -n "$LEVEL" ] || usage

# --- prerequisites (gh not needed — CI publishes the release) --------------
command -v node >/dev/null || die "node not found."
command -v npm  >/dev/null || die "npm not found."
command -v git  >/dev/null || die "git not found."
[ -f manifest.json ] || die "manifest.json not found — run this from the plugin repo."

# --- working tree must be clean (commit your real work first) --------------
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || die "You have uncommitted changes. Commit (or stash) them before releasing."

# --- upstream must exist and we must not be behind it ----------------------
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
[ -n "$UPSTREAM" ] || die "Current branch has no upstream. Push it once: git push -u origin <branch>"
git fetch --quiet || warn "git fetch failed; using last-known remote state."
git merge-base --is-ancestor '@{u}' HEAD \
  || die "Your branch is behind/diverged from $UPSTREAM. Pull or rebase before releasing."

# --- compute the next version (no mutation yet) ----------------------------
CURRENT="$(node -p "require('./manifest.json').version")"
VERSION="$(node -e '
  const lvl = process.argv[1];
  const cur = require("./manifest.json").version;
  if (/^[0-9]+\.[0-9]+\.[0-9]+$/.test(lvl)) { console.log(lvl); process.exit(0); }
  let [a,b,c] = cur.split(".").map(Number);
  if (lvl==="major"){a++;b=0;c=0;}
  else if (lvl==="minor"){b++;c=0;}
  else if (lvl==="patch"){c++;}
  else process.exit(2);
  console.log(`${a}.${b}.${c}`);
' "$LEVEL")" || die "Could not compute the next version."

if [ "$VERSION" = "$CURRENT" ]; then
  NEEDS_BUMP=0; info "Releasing current version $VERSION (no bump)"
else
  NEEDS_BUMP=1; info "Releasing $CURRENT -> $VERSION"
fi

# --- release notes are required (and human-written) ------------------------
NOTES_FILE="release-notes/$VERSION.md"
if [ ! -f "$NOTES_FILE" ]; then
  mkdir -p release-notes
  cat > "$NOTES_FILE" <<EOF
## Target Pane $VERSION

<!-- Write user-facing release notes below, then re-run the same release command. -->

### Changes
-
EOF
  die "Created $NOTES_FILE — fill in the notes, then re-run. (Nothing else was changed.)"
fi

# --- the tag must not already exist ----------------------------------------
git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null \
  && die "Tag $VERSION already exists locally."
git ls-remote --exit-code --tags origin "refs/tags/$VERSION" >/dev/null 2>&1 \
  && die "Tag $VERSION already exists on origin."

# --- fail fast: make sure it actually builds (CI builds for real) ----------
step "Build check (npm run build)..."
npm run build >/dev/null || die "Build failed locally — fix before releasing."

# --- confirm ---------------------------------------------------------------
if [ "$ASSUME_YES" -ne 1 ]; then
  printf '\n%sAbout to release %s:%s\n' "$YEL" "$VERSION" "$RST"
  printf '  - bump version files to %s (if needed), commit, and push to %s\n' "$VERSION" "$UPSTREAM"
  printf '  - create and push tag %s, which triggers the CI release (build + attest + publish)\n\n' "$VERSION"
  read -r -p "Proceed? [y/N] " reply
  case "$reply" in [yY]|[yY][eE][sS]) ;; *) die "Aborted. No changes made." ;; esac
fi

# --- bump (only when the version actually changes) -------------------------
if [ "$NEEDS_BUMP" -eq 1 ]; then
  step "Bumping version files to $VERSION..."
  npm version "$VERSION" --no-git-tag-version >/dev/null || die "npm version failed."
fi

# --- commit version files + notes (and push any earlier unpushed commits) --
git add package.json package-lock.json manifest.json versions.json "$NOTES_FILE"
if ! git diff --cached --quiet; then
  step "Committing..."
  git commit -m "Release $VERSION" >/dev/null || die "git commit failed."
fi
step "Pushing branch..."
git push || die "git push failed."

# --- tag and push the tag (this is what triggers CI) -----------------------
step "Tagging $VERSION and pushing the tag..."
git tag "$VERSION" || die "git tag failed."
git push origin "$VERSION" || die "git push (tag) failed. The branch is pushed; push the tag manually to release."

REPO_URL="$(git config --get remote.origin.url | sed -E 's#git@github.com:#https://github.com/#; s#\.git$##')"
info "Tag $VERSION pushed. CI is building, attesting, and publishing the release."
[ -n "$REPO_URL" ] && info "Watch it: ${REPO_URL}/actions"
