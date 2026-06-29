import { Keymap, Notice, PaneType, Plugin, WorkspaceLeaf, WorkspaceTabs, parseLinktext } from 'obsidian';

/** What kind of open a click intends, per Keymap.isModEvent: false = reuse, else new tab/split/window. */
type ClickIntent = PaneType | false;

interface TargetPaneSettings {
	/** Runtime id of the target leaf, persisted across restarts (Obsidian keeps leaf ids stable in workspace.json). */
	targetLeafId: string | null;
}

const DEFAULT_SETTINGS: TargetPaneSettings = {
	targetLeafId: null,
};

export default class TargetPanePlugin extends Plugin {
	settings: TargetPaneSettings = DEFAULT_SETTINGS;

	/** True only while we are inside an intercepted openLinkText call, so getLeaf knows to redirect. */
	private forceTargetLeaf = false;
	/** True for the brief window while a click on a note link is being handled. */
	private linkClickActive = false;
	/** True while we explicitly do NOT want to redirect (e.g. a same-file jump), overriding the click flag. */
	private suppressTargetLeaf = false;
	/** When set, getLeaf returns exactly this leaf (highest priority) — used to keep same-page jumps put. */
	private forceSpecificLeaf: WorkspaceLeaf | null = null;
	/** The leaf a link was clicked in, captured at click time. */
	private clickSourceLeaf: WorkspaceLeaf | null = null;
	/** Intent of the in-flight link click (false = reuse pane, 'tab'/'split'/'window' = new). */
	private pendingIntent: ClickIntent = false;
	/** Captured original Workspace.getLeaf, so we can create real tabs without re-entering our override. */
	private origGetLeaf: ((...args: unknown[]) => WorkspaceLeaf) | null = null;
	/**
	 * Live reference to the target *pane* (tab group). This — not the persisted leaf id — is the
	 * source of truth for on/off: the pane stays valid as its individual tabs come and go, and
	 * becomes invalid only when the whole pane is closed. The leaf id is just for restart recovery.
	 */
	private targetTabs: WorkspaceTabs | null = null;
	private statusBarEl: HTMLElement | null = null;

	/** Verbose dev logging. Set true while developing; ships false. */
	private static readonly DEBUG = false;

	/**
	 * A click within note content (editor / reading view / embed / hover preview).
	 * We flag any such click rather than matching specific link classes: the flag
	 * only affects behavior if a getLeaf actually fires during the click, and the
	 * only thing inside note content that calls getLeaf is opening a link/embed.
	 */
	private static readonly CONTENT_SELECTOR =
		'.cm-editor, .markdown-preview-view, .markdown-embed, .hover-popover';
	/** Explicit link elements, to also catch links outside the main content (e.g. backlinks pane). */
	private static readonly LINK_SELECTOR = 'a.internal-link, .markdown-embed-link, [data-href]';

	async onload() {
		await this.loadSettings();
		this.patchWorkspace();
		this.registerLinkClickTracking();

		// Command ids are auto-prefixed with the plugin id, so they must not repeat it.
		// Command names must not repeat the plugin name — the UI already shows it as a prefix.
		this.addCommand({
			id: 'set',
			name: 'Set to the active pane',
			callback: () => this.setTargetToActivePane(),
		});

		this.addCommand({
			id: 'clear',
			name: 'Clear',
			callback: () => this.clearTarget(),
		});

		this.statusBarEl = this.addStatusBarItem();
		this.updateStatusBar();

		// Re-link the target pane from the persisted leaf id once the workspace is laid out.
		this.app.workspace.onLayoutReady(() => this.restoreTarget());
		// Re-validate on every layout change: drop the target if its pane is gone, and keep the
		// persisted leaf id pointing at a live tab in the pane so restart recovery still works.
		this.registerEvent(
			this.app.workspace.on('layout-change', () => this.refreshTarget()),
		);

		this.debug('loaded');
	}

	onunload() {
		this.debug('unloaded');
	}

	private debug(...args: unknown[]) {
		if (TargetPanePlugin.DEBUG) console.log('[target-pane]', ...args);
	}

	/** Find which leaf a DOM element lives in (the pane a click happened in). */
	private leafFromEl(el: HTMLElement): WorkspaceLeaf | null {
		let found: WorkspaceLeaf | null = null;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && leaf.view.containerEl.contains(el)) found = leaf;
		});
		return found;
	}

	/** Best-effort link destination for logging (data-href in reading view, href on anchors). */
	private extractHref(el: HTMLElement): string | null {
		const link = el.closest('[data-href], a[href]');
		if (!link) return null;
		return link.getAttribute('data-href') ?? link.getAttribute('href');
	}

	/** True if a link points within the current note (pure subpath, or resolves back to the source file). */
	private isSameFileLink(linktext: string, sourcePath: string): boolean {
		const { path } = parseLinktext(linktext);
		if (!path) return true; // e.g. "#heading" or "#^block" — same note
		const dest = this.app.metadataCache.getFirstLinkpathDest(path, sourcePath);
		return dest ? dest.path === sourcePath : false;
	}

	/** Runtime leaf id (real property used by getLeafById, but absent from the public types). */
	private leafId(leaf: WorkspaceLeaf): string {
		return (leaf as unknown as { id: string }).id;
	}

	/** True if this tab group is still attached to the workspace (i.e. the pane isn't closed). */
	private isTabsAttached(tabs: WorkspaceTabs): boolean {
		let attached = false;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (leaf.parent === tabs) attached = true;
		});
		return attached;
	}

	/** The live target pane, or null if none set / the pane has been closed. */
	private resolveTargetTabs(): WorkspaceTabs | null {
		if (this.targetTabs && this.isTabsAttached(this.targetTabs)) return this.targetTabs;
		this.targetTabs = null;
		return null;
	}

	/** Rebuild the live pane reference from the persisted leaf id (after restart / reload). */
	private restoreTarget() {
		const id = this.settings.targetLeafId;
		const leaf = id ? this.app.workspace.getLeafById(id) : null;
		const parent = leaf ? leaf.parent : null;
		this.targetTabs = parent instanceof WorkspaceTabs ? parent : null;
		this.debug('restoreTarget', {
			id,
			foundLeaf: !!leaf,
			restoredPane: this.targetTabs !== null,
		});
		this.updateStatusBar();
	}

	/**
	 * Called on every layout change. If the pane is gone, clear the target (status -> off).
	 * If it survives but the persisted leaf closed, re-point the leaf id at a live tab so a
	 * later restart can still recover the pane.
	 */
	private refreshTarget() {
		const tabs = this.resolveTargetTabs();
		if (tabs) {
			// Keep the persisted leaf id pointing at a live tab in the pane (for restart recovery).
			const id = this.settings.targetLeafId;
			if (!id || !this.app.workspace.getLeafById(id)) {
				const rep = this.app.workspace.getMostRecentLeaf(tabs);
				if (rep) {
					this.settings.targetLeafId = this.leafId(rep);
					void this.saveSettings();
					this.debug('refreshTarget -> re-pointed persisted leaf id', {
						newId: this.settings.targetLeafId,
					});
				}
			}
		}
		// NOTE: do NOT clear the persisted leaf id when the pane is gone. App shutdown tears down
		// panes and looks identical to the user closing the pane — clearing here wiped restart
		// recovery. The in-memory target (targetTabs) already went null via resolveTargetTabs, so
		// status shows off; a genuinely-closed pane just fails to resolve on the next launch.
		this.updateStatusBar();
	}

	/**
	 * Decide which leaf a redirected open should land in, based on the requested pane type:
	 *  - false (plain click)   -> the pane's currently-active tab (replace it)
	 *  - 'tab'  (Cmd-click)    -> a new tab inside the pane
	 *  - 'split' / 'window'    -> null (let Obsidian do its natural thing — revisit later)
	 * Returns null to mean "don't redirect". Also schedules focus on the destination.
	 */
	private destinationForIntent(rawIntent: unknown): WorkspaceLeaf | null {
		const tabs = this.resolveTargetTabs();
		if (!tabs) return null;

		const intent: ClickIntent = rawIntent === true ? 'tab' : ((rawIntent as PaneType) || false);
		if (intent === 'split' || intent === 'window') {
			this.debug('intent -> natural behavior (no redirect)', { intent });
			return null;
		}

		const ws = this.app.workspace;
		const activeTab = ws.getMostRecentLeaf(tabs);

		let dest: WorkspaceLeaf | null;
		if (intent === 'tab') {
			// New tab in the pane: activate a leaf there, then ask the *original* getLeaf for a
			// new tab — which lands in that now-active pane.
			if (activeTab) ws.setActiveLeaf(activeTab, { focus: false });
			dest = this.origGetLeaf ? this.origGetLeaf('tab') : activeTab;
			this.debug('intent tab -> new tab in target pane', {
				hadOrigGetLeaf: !!this.origGetLeaf,
				activeTab: activeTab ? activeTab.getDisplayText() : null,
				destSameParentAsTarget: !!dest && dest.parent === tabs,
				destId: dest ? (dest as unknown as { id: string }).id : null,
			});
		} else {
			dest = activeTab;
			this.debug('intent reuse -> active tab in target pane', {
				tab: activeTab ? activeTab.getDisplayText() : null,
			});
		}

		this.focusSoon(dest);
		return dest;
	}

	/** Focus a leaf on the next tick, after the in-flight open has populated it. */
	private focusSoon(leaf: WorkspaceLeaf | null) {
		if (!leaf) return;
		window.setTimeout(() => {
			this.app.workspace.setActiveLeaf(leaf, { focus: true });
		}, 0);
	}

	private setTargetToActivePane() {
		const leaf = this.app.workspace.getMostRecentLeaf();
		if (!leaf) {
			new Notice('Target Pane: no active pane to target.');
			return;
		}
		const parent = leaf.parent;
		if (!(parent instanceof WorkspaceTabs)) {
			new Notice('Target Pane: this kind of pane can’t be targeted.');
			return;
		}
		this.targetTabs = parent;
		this.settings.targetLeafId = this.leafId(leaf);
		void this.saveSettings();
		this.updateStatusBar();

		const name = leaf.getDisplayText();
		new Notice(`Target pane set — links will open in this pane (now showing: ${name}).`);
	}

	private clearTarget() {
		this.targetTabs = null;
		this.settings.targetLeafId = null;
		void this.saveSettings();
		this.updateStatusBar();
		new Notice('Target Pane cleared.');
	}

	/**
	 * Redirect note-link opens into the target pane.
	 *
	 * Every note-link click — regardless of modifier keys (new tab / split /
	 * window) or source (editor, reading view, backlinks) — funnels through
	 * Workspace.openLinkText, which calls Workspace.getLeaf to choose a
	 * destination. We wrap openLinkText so that, while a target is set, getLeaf
	 * returns the target leaf instead. This reuses Obsidian's own link resolution
	 * (subpaths, scroll-to-heading, create-on-missing) and only changes *where*
	 * the result lands.
	 */
	private patchWorkspace() {
		const ws = this.app.workspace as unknown as {
			openLinkText: (...args: unknown[]) => Promise<void>;
			getLeaf: (...args: unknown[]) => WorkspaceLeaf;
		};
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- the patched openLinkText/getLeaf must keep `this` bound to the workspace (so they can't be arrow functions); we capture the plugin instance separately to reach its state and methods
		const plugin: TargetPanePlugin = this;
		const origOpenLinkText = ws.openLinkText;
		const origGetLeaf = ws.getLeaf;
		// Bind to the workspace so we can call it from helpers without `this` being wrong.
		this.origGetLeaf = origGetLeaf.bind(ws);

		ws.openLinkText = async function (
			this: unknown,
			linktext: unknown,
			sourcePath: unknown,
			newLeaf: unknown,
			openViewState: unknown,
		): Promise<void> {
			const tabs = plugin.resolveTargetTabs();
			const sameFile = plugin.isSameFileLink(linktext as string, sourcePath as string);
			plugin.debug('openLinkText', {
				linktext,
				newLeaf,
				sameFile,
				hasTargetPane: !!tabs,
				sourceLeaf: plugin.clickSourceLeaf ? plugin.clickSourceLeaf.getDisplayText() : null,
			});

			// No target pane set -> leave everything to Obsidian.
			if (!tabs) {
				return origOpenLinkText.call(this, linktext, sourcePath, newLeaf, openViewState);
			}

			// Same-page jump (e.g. "#heading") -> keep it in the pane it was clicked in.
			if (sameFile) {
				const sourceLeaf = plugin.clickSourceLeaf;
				if (sourceLeaf) {
					plugin.debug('same-page jump -> keeping in source leaf', {
						sourceLeaf: sourceLeaf.getDisplayText(),
					});
					plugin.app.workspace.setActiveLeaf(sourceLeaf, { focus: true });
					plugin.forceSpecificLeaf = sourceLeaf;
					try {
						return await origOpenLinkText.call(this, linktext, sourcePath, false, openViewState);
					} finally {
						plugin.forceSpecificLeaf = null;
					}
				}
				// Unknown source leaf: just don't hijack it into the target pane.
				plugin.suppressTargetLeaf = true;
				try {
					return await origOpenLinkText.call(this, linktext, sourcePath, newLeaf, openViewState);
				} finally {
					plugin.suppressTargetLeaf = false;
				}
			}

			// Cross-file link -> redirect into the target pane, honoring the intent (newLeaf).
			// getLeaf (below) turns the intent into the right destination within the pane.
			plugin.forceTargetLeaf = true;
			try {
				await origOpenLinkText.call(this, linktext, sourcePath, newLeaf, openViewState);
			} finally {
				plugin.forceTargetLeaf = false;
			}
		};

		ws.getLeaf = function (this: unknown, ...args: unknown[]): WorkspaceLeaf {
			if (plugin.forceSpecificLeaf) {
				plugin.debug('getLeaf -> forced source leaf (same-page)');
				return plugin.forceSpecificLeaf;
			}
			if (!plugin.suppressTargetLeaf && (plugin.forceTargetLeaf || plugin.linkClickActive)) {
				plugin.debug('getLeaf intercept', {
					args,
					forceTargetLeaf: plugin.forceTargetLeaf,
					linkClickActive: plugin.linkClickActive,
				});
				const dest = plugin.destinationForIntent(args[0]);
				if (dest) return dest;
			}
			return origGetLeaf.apply(this, args);
		};

		// Restore the originals when the plugin unloads.
		this.register(() => {
			ws.openLinkText = origOpenLinkText;
			ws.getLeaf = origGetLeaf;
		});
	}

	/**
	 * Mod-click and middle-click on a link bypass openLinkText and call getLeaf
	 * directly, so we can't catch them via the openLinkText wrapper. Instead we
	 * note, in the capture phase (before Obsidian's own handler runs), that a
	 * click is landing inside note content (or on an explicit link element), and
	 * clear the flag on the next tick. While the flag is set, getLeaf redirects to
	 * the target leaf — which only matters if the click actually opens something.
	 */
	private registerLinkClickTracking() {
		const onLinkClick = (evt: MouseEvent) => {
			const el = evt.target as HTMLElement | null;
			if (!el) return;
			const matched =
				el.closest(TargetPanePlugin.CONTENT_SELECTOR) ||
				el.closest(TargetPanePlugin.LINK_SELECTOR);
			if (!matched) return;
			if (!this.resolveTargetTabs()) return;

			// Classify the click the same way Obsidian does, so we can branch on it later.
			const intent = Keymap.isModEvent(evt) as ClickIntent;
			this.pendingIntent = intent;
			this.clickSourceLeaf = this.leafFromEl(el);
			this.debug('link click', {
				eventType: evt.type,
				button: evt.button,
				intent, // false = reuse pane, 'tab' | 'split' | 'window' = new
				mods: { meta: evt.metaKey, ctrl: evt.ctrlKey, alt: evt.altKey, shift: evt.shiftKey },
				href: this.extractHref(el),
				sourceLeaf: this.clickSourceLeaf ? this.clickSourceLeaf.getDisplayText() : null,
			});

			this.linkClickActive = true;
			// Clear the getLeaf flag after the synchronous event dispatch completes. Leave
			// clickSourceLeaf in place — openLinkText (async) reads it after this tick.
			window.setTimeout(() => {
				this.linkClickActive = false;
			}, 0);
		};
		this.registerDomEvent(activeDocument, 'click', onLinkClick, { capture: true });
		this.registerDomEvent(activeDocument, 'auxclick', onLinkClick, { capture: true });
	}

	private updateStatusBar() {
		if (!this.statusBarEl) return;
		const active = this.resolveTargetTabs() !== null;
		this.statusBarEl.setText(active ? '🎯 Target pane: on' : '🎯 Target pane: off');
	}

	private async loadSettings() {
		const data = (await this.loadData()) as Partial<TargetPaneSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
	}

	private async saveSettings() {
		await this.saveData(this.settings);
	}
}
