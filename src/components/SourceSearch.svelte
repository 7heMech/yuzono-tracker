<script lang="ts">
  /**
   * Filters the source list that is already in the page.
   *
   * It used to receive all 310 sources as props and render the grid itself,
   * which put the catalogue into the HTML twice — once as escaped JSON, once as
   * the list — and made the filter unavailable until 8.4 KB gzipped of props
   * and 15.3 KB gzipped of Svelte runtime had arrived. Now /sources/ renders
   * the list and this island only shows and hides rows, so what has to load
   * first is the runtime alone. After that a keystroke is a substring test
   * against 310 cached strings and a `hidden` flag per row — no network, no
   * re-render of the list, no D1.
   *
   * The two numbers are so that the count reads correctly in the static HTML
   * before this hydrates. Deliberately not the catalogue: the rows themselves
   * are read out of the DOM.
   */
  let { total, visible }: { total: number; visible: number } = $props();

  let q = $state('');
  let showNsfw = $state(false);

  /**
   * `null` until the filter has run once, so the count in the server-rendered
   * HTML is `visible` — the number that actually matches the markup, 18+ rows
   * hidden — and hydration does not make it flicker from a placeholder.
   */
  let counted = $state<number | null>(null);
  const shown = $derived(counted ?? visible);

  /** One row of the server-rendered grid, with its match key precomputed. */
  type Entry = { el: HTMLElement; key: string; nsfw: boolean };

  // `$state.raw`, not `$state`: these hold live DOM nodes and Svelte's deep
  // proxy would wrap every element. Raw state still tracks reassignment, which
  // is all the effect below needs.
  let grid = $state.raw<HTMLElement | null>(null);
  let entries = $state.raw<Entry[]>([]);

  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

  /**
   * Reads the grid once, on mount. `norm()` over 620 strings is the only
   * expensive thing this component does, so it happens here rather than on
   * every keystroke.
   *
   * The name comes back out of `.cell-name` instead of a data attribute,
   * because an attribute would be a second copy of the thing this change
   * removed. The extension name is only in `data-ext` where it differs from
   * the name — 47 of 310 — and falls back to the name otherwise.
   */
  $effect(() => {
    const el = document.getElementById('source-grid');
    if (!el) return;
    entries = [...el.children].map((child) => {
      const li = child as HTMLElement;
      const name = li.querySelector('.cell-name')?.textContent ?? '';
      // NUL joins the two searchable strings so one `includes` covers both. A
      // needle can never contain it: norm() keeps only a-z0-9, so no query can
      // match across the join.
      return {
        el: li,
        key: `${norm(name)}\0${norm(li.dataset.ext ?? name)}`,
        nsfw: li.dataset.nsfw !== undefined,
      };
    });
    grid = el;
  });

  /**
   * Applies the filter. `hidden` rather than a class or `visibility`, because a
   * filtered-out row has to leave the accessibility tree and the tab order —
   * otherwise a screen reader still reads all 310 names and a keyboard visitor
   * tabs through links they cannot see.
   */
  $effect(() => {
    if (!grid) return;
    const needle = norm(q);
    let count = 0;
    for (const entry of entries) {
      const hide = (entry.nsfw && !showNsfw) || (needle !== '' && !entry.key.includes(needle));
      entry.el.hidden = hide;
      if (!hide) count += 1;
    }
    counted = count;
    // With every row hidden the container would still paint as a bordered
    // 1px strip above the empty state, so it goes too.
    grid.hidden = count === 0;
  });
</script>

<div class="controls">
  <input
    class="input"
    type="search"
    bind:value={q}
    placeholder="Filter {total} sources by name…"
    aria-label="Filter sources by name"
    aria-controls="source-grid"
    autocomplete="off"
  />
  <button
    class="chip"
    type="button"
    aria-pressed={showNsfw}
    onclick={() => (showNsfw = !showNsfw)}
  >18+</button>
</div>

<p class="count" aria-live="polite">
  <span class="num">{shown}</span> of {total} sources
</p>

{#if shown === 0}
  <div class="empty">
    <p class="empty-title">No source matches "{q}"</p>
    <p>It may not be in this repo yet. You can request it.</p>
    <a class="btn btn-primary" href="/request">Request a source</a>
  </div>
{/if}

<style>
  .controls {
    display: flex;
    gap: var(--space-2);
    align-items: center;
    padding-block: var(--space-4) var(--space-2);
  }
  .controls .input { max-inline-size: 24rem; }
  .count {
    font-size: var(--text-sm);
    color: var(--text-tertiary);
    padding-block-end: var(--space-3);
  }
  .count .num { color: var(--text-primary); font-weight: var(--weight-medium); }
</style>
