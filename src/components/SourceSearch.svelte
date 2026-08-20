<script lang="ts">
  // The catalogue is static per build, so filtering 310 sources happens here
  // with zero round-trips. This is the payoff for prerendering the page: the
  // list is instant and D1 is never touched for an anonymous browse.
  type Row = { id: string; name: string; lang: string; nsfw: boolean; extName: string };

  let { sources, langLabels }: { sources: Row[]; langLabels: Record<string, string> } = $props();

  let q = $state('');
  let showNsfw = $state(false);

  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

  const shown = $derived.by(() => {
    const needle = norm(q);
    return sources.filter((s) => {
      if (s.nsfw && !showNsfw) return false;
      if (!needle) return true;
      return norm(s.name).includes(needle) || norm(s.extName).includes(needle);
    });
  });
</script>

<div class="controls">
  <input
    class="input"
    type="search"
    bind:value={q}
    placeholder="Filter {sources.length} sources by name…"
    aria-label="Filter sources by name"
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
  <span class="num">{shown.length}</span> of {sources.length} sources
</p>

{#if shown.length === 0}
  <div class="empty">
    <p class="empty-title">No source matches “{q}”</p>
    <p>It may not be in this repo yet — you can request it.</p>
    <a class="btn btn-primary" href="/request">Request a source</a>
  </div>
{:else}
  <ul class="grid">
    {#each shown as s (s.id)}
      <li>
        <a class="cell" href={`/source/${s.id}`}>
          <span class="cell-name">{s.name}</span>
          <span class="cell-meta">
            <span class="lang" title={langLabels[s.lang] ?? s.lang}>{s.lang}</span>
            {#if s.nsfw}<span class="flag">18+</span>{/if}
          </span>
        </a>
      </li>
    {/each}
  </ul>
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

  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
    gap: 1px;
    background: var(--border-subtle);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-lg);
    overflow: hidden;
  }
  .cell {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    block-size: 100%;
    background: var(--surface-raised);
    transition: background var(--dur-fast) var(--ease-standard);
  }
  .cell:hover { background: var(--surface-hover); }
  .cell-name {
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .cell-meta { display: flex; align-items: center; gap: var(--space-1); flex: none; }
  .flag {
    font-family: var(--font-data);
    font-size: var(--text-xs);
    color: var(--dead);
  }
</style>
