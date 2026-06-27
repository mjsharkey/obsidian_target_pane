# Contributing to Target Pane

Thanks for your interest in improving Target Pane! Contributions of all kinds are welcome —
bug reports, feature ideas, documentation fixes, and code.

This is a small, friendly project. You don't need to be an Obsidian expert to help.

## Ways to contribute

### 🐛 Report a bug

Open an [issue][issues] and include:

- What you did (ideally numbered steps to reproduce).
- What you expected to happen.
- What actually happened.
- Your Obsidian version and operating system.
- Any errors from the developer console (`Cmd/Ctrl-Shift-I` → Console).

### 💡 Suggest a feature

Open an [issue][issues] describing the **workflow** you want, not just the implementation. For
example: "When I Cmd-Alt-click a link I'd like it to split *inside* the target pane." Concrete
use cases are what shape the roadmap.

### 🔧 Submit a pull request

1. **Fork** the repository and create a branch from `main`:
   ```bash
   git checkout -b my-change
   ```
2. **Make your change.** Keep pull requests small and focused — one logical change per PR is
   much easier to review and merge.
3. **Build it** to make sure it type-checks and bundles:
   ```bash
   npm install
   npm run build
   ```
4. **Test it** in a real vault (see [Development](README.md#development) in the README for the
   symlink + Hot-Reload setup). Please describe what you tested in the PR.
5. **Open the pull request** against `main` with a clear description of what changed and why.

If you're unsure about an approach, feel free to open an issue or a draft PR to discuss before
investing a lot of time.

## Development setup

See the [Development section of the README](README.md#development) for the full workflow. The
short version:

```bash
git clone https://github.com/<your-username>/obsidian_target_pane.git
cd obsidian_target_pane
npm install
npm run dev      # esbuild watch mode
```

Symlink the repo into a test vault's `.obsidian/plugins/` folder and use the
[Hot-Reload](https://github.com/pjeby/hot-reload) plugin for fast iteration.

### Project layout

- `src/main.ts` — the entire plugin (single file for now).
- `manifest.json` / `versions.json` — plugin metadata.
- `esbuild.config.mjs` — bundler config.
- `main.js` — generated build output (not committed; attached to releases).

### A note on style

- Match the existing code: TypeScript, tabs for indentation, `const`/`let` (never `var`).
- The plugin follows Obsidian's [plugin guidelines][guidelines] — please keep new code
  compatible (no stray `console.log`, use `this.app`, register listeners for cleanup, etc.).
- There's a `DEBUG` flag at the top of the plugin class for verbose logging while developing;
  it ships as `false`.

## Code of conduct

Be kind and constructive. We're all here to make a useful tool a little better.

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.

[issues]: https://github.com/mjsharkey/obsidian_target_pane/issues
[guidelines]: https://docs.obsidian.md/Plugins/Releasing/Plugin+guidelines
