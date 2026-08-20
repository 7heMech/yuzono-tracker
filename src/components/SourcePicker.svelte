<script lang="ts">
  // Same instant local matching as the board finder, but it fills a hidden
  // input instead of navigating — so step 1 of filing never costs a round trip.
  type Row = { id: string; name: string; lang: string; nsfw: boolean; extName: string };

  let {
    sources,
    langLabels,
    selectedId = '',
    selectedName = '',
  }: {
    sources: Row[];
    langLabels: Record<string, string>;
    selectedId?: string;
    selectedName?: string;
  } = $props();

  let chosen = $state(selectedId ? { id: selectedId, name: selectedName } : null);
  let q = $state('');
  let active = $state(0);
  let input: HTMLInputElement | undefined;

  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

  const hits = $derived.by(() => {
    const n = norm(q);
    if (n.length < 2) return [];
    const starts: Row[] = [];
    const contains: Row[] = [];
    for (const s of sources) {
      const name = norm(s.name);
      if (name.startsWith(n)) starts.push(s);
      else if (name.includes(n) || norm(s.extName).includes(n)) contains.push(s);
    }
    return [...starts, ...contains].slice(0, 7);
  });

  function pick(s: Row) {
    chosen = { id: s.id, name: s.name };
    q = '';
  }

  function clear() {
    chosen = null;
    q = '';
    requestAnimationFrame(() => input?.focus());
  }

  function onKey(e: KeyboardEvent) {
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % hits.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + hits.length) % hits.length; }
    else if (e.key === 'Enter') { e.preventDefault(); pick(hits[active]); }
  }
</script>

<input type="hidden" name="source" value={chosen?.id ?? ''} />

{#if chosen}
  <div class="picked">
    <span class="picked-name">{chosen.name}</span>
    <button class="btn btn-ghost" type="button" onclick={clear}>Change</button>
  </div>
{:else}
  <div class="wrap">
    <input
      class="input"
      type="search"
      autocomplete="off"
      bind:this={input}
      bind:value={q}
      onkeydown={onKey}
      placeholder="Start typing a source name…"
      aria-label="Search for the source"
      role="combobox"
      aria-expanded={hits.length > 0}
      aria-autocomplete="list"
    />
    {#if q.trim().length >= 2}
      <ul class="results" role="listbox">
        {#each hits as s, i (s.id)}
          <li role="option" aria-selected={i === active}>
            <button type="button" class="hit" class:active={i === active} onclick={() => pick(s)}>
              <span>{s.name}</span>
              <span class="lang">{langLabels[s.lang] ?? s.lang}</span>
            </button>
          </li>
        {:else}
          <li class="none">
            Not in this repo. <a href={`/new?kind=request&name=${encodeURIComponent(q)}`}>Request it</a> instead.
          </li>
        {/each}
      </ul>
    {/if}
  </div>
{/if}

<style>
  .wrap { position: relative; }
  .results {
    position: absolute;
    inset-inline: 0;
    inset-block-start: calc(100% + 4px);
    z-index: var(--z-dropdown);
    background: var(--surface-overlay);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .hit {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    inline-size: 100%;
    padding: var(--space-2) var(--space-3);
    font-size: var(--text-sm);
    text-align: start;
  }
  .hit:hover, .hit.active { background: var(--surface-active); }
  .none { padding: var(--space-3); font-size: var(--text-sm); color: var(--text-tertiary); }
  .none a { color: var(--signal-ink); text-decoration: underline; }

  .picked {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-inset);
  }
  .picked-name { font-weight: var(--weight-medium); }
</style>
