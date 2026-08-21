<script module lang="ts">
  /** One row of /sources.json, decoded. */
  type Row = { name: string; path: string; lang: string; nsfw: boolean; extName: string };
  /** The positional payload /sources.json emits — see src/pages/sources.json.ts. */
  type Payload = { l: string[]; s: [string, string, number, number, string?][] };

  /**
   * Module scope, so a second mount of this component on the same page reuses
   * the first one's fetch instead of starting another. The homepage has one
   * finder, but /404 has one too and a client-side navigation between them
   * would otherwise pay for the catalogue twice.
   */
  let inflight: Promise<Row[]> | null = null;

  function loadCatalogue(): Promise<Row[]> {
    inflight ??= fetch('/sources.json')
      .then((res) => {
        if (!res.ok) throw new Error(`/sources.json answered ${res.status}`);
        return res.json() as Promise<Payload>;
      })
      .then(({ l, s }) =>
        s.map(([name, path, lang, nsfw, extName]) => ({
          name,
          path,
          lang: l[lang] ?? '',
          nsfw: nsfw === 1,
          // Absent on the 263 sources whose extension is named after them.
          extName: extName ?? name,
        })),
      )
      .catch((err) => {
        // A failure must not be cached, or one dropped request disables the
        // finder for the rest of the page's life. Clearing it lets the next
        // focus try again.
        inflight = null;
        throw err;
      });
    return inflight;
  }
</script>

<script lang="ts">
  /**
   * The first question anyone arrives with is "is my source already reported?",
   * so this is the top of the board rather than a filter buried in a toolbar.
   *
   * It takes no props. It used to be handed all 310 sources and a language-label
   * map as hydration props, which meant every visitor to `/`, `/sources/` and
   * `/new` downloaded and parsed the whole catalogue inside the HTML — 8.4 KB
   * gzipped, 44% of the transfer on /sources/ — to serve the minority who
   * actually typed something. Now the catalogue is a static file fetched on
   * first focus of the input. Matching is still local and instant once it has
   * arrived; the cost has moved to the people who use the feature.
   *
   * Typing before it arrives is fine: `q` is bound to the input independently of
   * the data, so nothing is dropped and the results appear as soon as the fetch
   * resolves.
   */
  let q = $state('');
  let open = $state(false);
  let active = $state(0);
  let rows = $state.raw<Row[] | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let box: HTMLDivElement;

  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

  /**
   * Starts the fetch, at most once per page. On focus rather than on mount:
   * the whole point of moving the catalogue out of the props was to stop
   * charging every visitor for it, and mounting is not intent.
   */
  function begin() {
    open = true;
    if (rows || loading) return;
    loading = true;
    failed = false;
    loadCatalogue().then(
      (loaded) => {
        rows = loaded;
        loading = false;
      },
      () => {
        failed = true;
        loading = false;
      },
    );
  }

  const hits = $derived.by(() => {
    const n = norm(q);
    if (n.length < 2 || !rows) return [];
    const starts: Row[] = [];
    const contains: Row[] = [];
    for (const s of rows) {
      const name = norm(s.name);
      if (name.startsWith(n)) starts.push(s);
      else if (name.includes(n) || norm(s.extName).includes(n)) contains.push(s);
      if (starts.length >= 8) break;
    }
    return [...starts, ...contains].slice(0, 8);
  });

  /** True whenever the dropdown is on screen, whatever it is showing. */
  const panel = $derived(open && q.trim().length >= 2);

  $effect(() => {
    // Reset the highlight whenever the result set changes. Without the read of
    // `hits` this effect ran once on mount and never again, so after typing a
    // second word Enter could navigate to a row that had scrolled out of the
    // list — the index survived, the row it pointed at did not.
    void hits;
    active = 0;
  });

  function go(s: Row) {
    // `s.path` is sourcePath() output from the build, trailing slash included.
    // Do not rebuild it here: these are prerendered directories and a path
    // without the slash costs a 307 before the page loads.
    window.location.href = s.path;
  }

  function onKey(e: KeyboardEvent) {
    // Escape is handled before the emptiness guard: it has to close a dropdown
    // that is showing "no match" or "loading" just as much as one with results.
    if (e.key === 'Escape') {
      open = false;
      return;
    }
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % hits.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + hits.length) % hits.length; }
    else if (e.key === 'Enter') { e.preventDefault(); go(hits[active]); }
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
      oninput={begin}
      onfocus={begin}
      onkeydown={onKey}
      placeholder="Type a source name: AnimePahe, Cuevana…"
      role="combobox"
      aria-expanded={panel}
      aria-controls="finder-results"
      aria-autocomplete="list"
    />
  </div>

  {#if panel}
    <ul class="results" id="finder-results" role="listbox">
      {#if failed}
        <li class="none" role="presentation">
          <p>The source list didn't load.</p>
          <a class="btn btn-primary" href="/sources/">Browse all sources</a>
        </li>
      {:else if !rows}
        <!-- In words, not a spinner: the wait is for a file, and saying so is
             the difference between "still working" and "broken". -->
        <li class="none" role="presentation" aria-live="polite">
          <p>Fetching the source list…</p>
        </li>
      {:else if hits.length}
        {#each hits as s, i (s.path)}
          <li role="option" aria-selected={i === active}>
            <button type="button" class="hit" class:active={i === active} onclick={() => go(s)}>
              <span class="hit-name">{s.name}</span>
              <span class="hit-meta">
                <span class="lang">{s.lang}</span>
                {#if s.nsfw}<span class="hit-nsfw">18+</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      {:else}
        <li class="none" role="presentation">
          <p>No source called "{q}" in this repo.</p>
          <a class="btn btn-primary" href={`/request?name=${encodeURIComponent(q)}`}>
            Request it instead
          </a>
        </li>
      {/if}
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
