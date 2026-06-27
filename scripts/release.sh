#!/usr/bin/env bash
#
# release.sh — one-command release for the Target Pane Obsidian plugin.
#
# Does ALL the bookkeeping: bumps the version everywhere, commits, pushes, builds,
# and publishes a GitHub Release (tag == manifest version) with main.js,
# manifest.json, and styles.css attached as individual assets.
#
# Usage:
#   ./scripts/release.sh <patch|minor|major|X.Y.Z> [-y]
#
#   patch|minor|major   bump the current version by that semver level
#   X.Y.Z               set this exact version
#   -y, --yes           don't ask for confirmation
#
# You supply two things: the bump level and the release notes
# (release-notes/<version>.md). Everything else is automatic.
#
# NOTE: this script runs `git commit` and `git push` on your behalf.
#
set -euo pipefail

# --- pretty output ---------------------------------------------------------
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

# --- prerequisites ---------------------------------------------------------
command -v node >/dev/null || die "node not found."
command -v npm  >/dev/null || die "npm not found."
command -v git  >/dev/null || die "git not found."
command -v gh   >/dev/null || die "GitHub CLI (gh) not found. Install it, then: gh auth login"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated. Run: gh auth login"
[ -f manifest.json ] || die "manifest.json not found — run this from the plugin repo."

# --- working tree must be clean (your real work already committed) ---------
[ -z "$(git status --porcelain --untracked-files=no)" ] \
  || die "You have uncommitted changes. Commit (or stash) your work before releasing."

# --- branch must be in sync with its upstream ------------------------------
UPSTREAM="$(git rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
[ -n "$UPSTREAM" ] || die "Current branch has no upstream. Push it once: git push -u origin <branch>"
git fetch --quiet || warn "git fetch failed; using last-known remote state."
[ "$(git rev-parse HEAD)" = "$(git rev-parse '@{u}')" ] \
  || die "Local branch and $UPSTREAM have diverged. Sync them (push/pull) before releasing."

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
  NEEDS_BUMP=0
  info "Releasing current version $VERSION (no bump)"
else
  NEEDS_BUMP=1
  info "Releasing $CURRENT -> $VERSION"
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

# --- nothing must already claim this version -------------------------------
git rev-parse -q --verify "refs/tags/$VERSION" >/dev/null \
  && die "Tag $VERSION already exists locally."
git ls-remote --exit-code --tags origin "refs/tags/$VERSION" >/dev/null 2>&1 \
  && die "Tag $VERSION already exists on origin."
gh release view "$VERSION" >/dev/null 2>&1 \
  && die "A GitHub release named $VERSION already exists."

# --- build & verify assets BEFORE any mutation -----------------------------
step "Building (npm run build)…"
npm run build >/dev/null || die "Build failed (run 'npm run build' to see the error)."
for f in main.js manifest.json styles.css; do
  [ -f "$f" ] || die "Expected release asset '$f' is missing after build."
done

# --- confirm ---------------------------------------------------------------
if [ "$ASSUME_YES" -ne 1 ]; then
  printf '\n%sAbout to release %s:%s\n' "$YEL" "$VERSION" "$RST"
  printf '  • bump package.json / manifest.json / versions.json to %s\n' "$VERSION"
  printf '  • commit "Release %s" and push to %s\n' "$VERSION" "$UPSTREAM"
  printf '  • create GitHub release %s and upload main.js, manifest.json, styles.css\n\n' "$VERSION"
  read -r -p "Proceed? [y/N] " reply
  case "$reply" in [yY]|[yY][eE][sS]) ;; *) die "Aborted. No changes made." ;; esac
fi

# --- bump (only when the version actually changes) -------------------------
if [ "$NEEDS_BUMP" -eq 1 ]; then
  step "Bumping version files to $VERSION…"
  npm version "$VERSION" --no-git-tag-version >/dev/null || die "npm version failed."
fi

# --- commit any resulting changes (bump and/or new notes), then push -------
git add package.json manifest.json versions.json "$NOTES_FILE"
if ! git diff --cached --quiet; then
  step "Committing and pushing…"
  git commit -m "Release $VERSION" >/dev/null || die "git commit failed."
  git push || die "git push failed. Your commit is local — push and finish manually."
else
  step "Nothing new to commit; releasing the current commit as-is."
fi

# --- publish ---------------------------------------------------------------
step "Creating GitHub release $VERSION and uploading assets…"
gh release create "$VERSION" \
  main.js manifest.json styles.css \
  --target "$(git rev-parse HEAD)" \
  --title "$VERSION" \
  --notes-file "$NOTES_FILE" \
  || die "gh release create failed. The commit is pushed; you can retry just the release."

URL="$(gh release view "$VERSION" --json url -q .url 2>/dev/null || true)"
info "Released $VERSION.${URL:+ $URL}"
