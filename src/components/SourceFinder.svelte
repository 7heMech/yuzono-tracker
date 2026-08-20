<script lang="ts">
  // The first question anyone arrives with is "is my source already reported?",
  // so this is the top of the board rather than a filter buried in a toolbar.
  // The catalogue is static, so matching is instant and local.
  type Row = { id: string; name: string; lang: string; nsfw: boolean; extName: string };

  let { sources, langLabels }: { sources: Row[]; langLabels: Record<string, string> } = $props();

  let q = $state('');
  let open = $state(false);
  let active = $state(0);
  let box: HTMLDivElement;

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
      if (starts.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 8);
  });

  $effect(() => {
    active = 0;
  });

  function go(s: Row) {
    window.location.href = `/source/${s.id}`;
  }

  function onKey(e: KeyboardEvent) {
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % hits.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + hits.length) % hits.length; }
    else if (e.key === 'Enter') { e.preventDefault(); go(hits[active]); }
    else if (e.key === 'Escape') { open = false; }
  }
</script>

<svelte:window onclick={(e) => { if (box && !box.contains(e.target as Node)) open = false; }} />

<div class="finder" bind:this={box}>
  <label class="finder-label" for="finder">Check your source</label>
  <div class="finder-input">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" />
    </svg>
    <input
      class="input"
      id="finder"
      type="search"
      autocomplete="off"
      bind:value={q}
      oninput={() => (open = true)}
      onfocus={() => (open = true)}
      onkeydown={onKey}
      placeholder="Type a source name — AnimePahe, Cuevana…"
      role="combobox"
      aria-expanded={open && hits.length > 0}
      aria-controls="finder-results"
      aria-autocomplete="list"
    />
  </div>

  {#if open && q.trim().length >= 2}
    <ul class="results" id="finder-results" role="listbox">
      {#each hits as s, i (s.id)}
        <li role="option" aria-selected={i === active}>
          <button type="button" class="hit" class:active={i === active} onclick={() => go(s)}>
            <span class="hit-name">{s.name}</span>
            <span class="hit-meta">
              <span class="lang">{langLabels[s.lang] ?? s.lang}</span>
              {#if s.nsfw}<span class="hit-nsfw">18+</span>{/if}
            </span>
          </button>
        </li>
      {:else}
        <li class="none">
          <p>No source called “{q}” in this repo.</p>
          <a class="btn btn-primary" href={`/request?name=${encodeURIComponent(q)}`}>
            Request it instead
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .finder { position: relative; }
  .finder-label {
    display: block;
    font-size: var(--text-sm);
    font-weight: var(--weight-medium);
    color: var(--text-secondary);
    margin-block-end: var(--space-1);
  }
  .finder-input { position: relative; display: flex; align-items: center; }
  .finder-input svg {
    position: absolute;
    inset-inline-start: var(--space-3);
    color: var(--text-muted);
    pointer-events: none;
  }
  .finder-input .input { padding-inline-start: 34px; }

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
    text-align: start;
  }
  .hit:hover, .hit.active { background: var(--surface-active); }
  .hit-name { font-size: var(--text-sm); font-weight: var(--weight-medium); }
  .hit-meta { display: flex; align-items: center; gap: var(--space-2); flex: none; }
  .hit-nsfw { font-family: var(--font-data); font-size: var(--text-xs); color: var(--dead); }
  .none {
    display: grid;
    gap: var(--space-2);
    justify-items: start;
    padding: var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }
</style>
