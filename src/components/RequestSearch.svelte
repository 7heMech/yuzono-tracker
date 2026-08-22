<script module lang="ts">
  import { suggestRequests } from '../lib/requests';
  import { loadRequestFeed, type FeatureRow, type RequestRow } from '../lib/request-feed';

  /** Either kind of ask, in one list, because this box searches both. */
  type Row = RequestRow | FeatureRow;

  /** The address of a site, or the ask of a feature: one line either way. */
  const detailOf = (r: Row) => r.url ?? r.text ?? '';
</script>

<script lang="ts">
  /**
   * The first question anyone arrives at this board with is "has somebody
   * already asked for this?", so it is the top of the page.
   *
   * Deliberately the same shape as SourceFinder on the broken board — same
   * label-input-dropdown, same keyboard handling, same fetch-on-first-use — but
   * over the open asks rather than the catalogue, because that is what this
   * board holds. A hit goes to the request, where the vote button is.
   *
   * This replaced a full-width primary button. The button was the only way on
   * to /request, so it had to shout; a search box answers the more common
   * question first and leaves the filing to a plain link beside it, which is
   * how the broken board has always done it.
   */
  let q = $state('');
  let open = $state(false);
  let active = $state(0);
  let rows = $state.raw<Row[] | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let box: HTMLDivElement;

  /**
   * Starts the fetch, at most once per page. On focus *and* on input: focus
   * alone misses a pasted value, an autofill and a restored one, and mounting
   * is not intent — the majority of this board's visitors only scroll it.
   */
  function begin() {
    open = true;
    if (rows || loading) return;
    loading = true;
    failed = false;
    loadRequestFeed().then(
      (feed) => {
        // Source requests first, so a two-letter query that matches both kinds
        // shows the board's own bread and butter before the features.
        rows = [...feed.requests, ...feed.features];
        loading = false;
      },
      () => {
        failed = true;
        loading = false;
      },
    );
  }

  const hits = $derived(rows ? (suggestRequests(rows, q, '', 8) as Row[]) : []);

  /** True whenever the dropdown is on screen, whatever it is showing. */
  const panel = $derived(open && q.trim().length >= 2);

  $effect(() => {
    // Reset the highlight whenever the result set changes, or Enter can
    // navigate to a row that has since scrolled out of the list.
    void hits;
    active = 0;
  });

  const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);

  function go(r: Row) {
    window.location.href = `/report/${r.id}`;
  }

  function onKey(e: KeyboardEvent) {
    // Escape first: it has to close a dropdown showing "no match" or "loading"
    // just as much as one with results.
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
  <label class="finder-label" for="request-finder">Search what people have asked for</label>
  <div class="finder-input">
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5 21 21" />
    </svg>
    <input
      class="input"
      id="request-finder"
      type="search"
      autocomplete="off"
      bind:value={q}
      oninput={begin}
      onfocus={begin}
      onkeydown={onKey}
      placeholder="A site or a feature: AnimeFire, import library…"
      role="combobox"
      aria-expanded={panel}
      aria-controls="request-results"
      aria-autocomplete="list"
    />
  </div>

  {#if panel}
    <ul class="results" id="request-results" role="listbox">
      {#if failed}
        <li class="none" role="presentation">
          <p>The list didn't load.</p>
          <a class="btn btn-primary" href="/request">Make a request</a>
        </li>
      {:else if !rows}
        <!-- In words, not a spinner: the wait is for a file, and saying so is
             the difference between "still working" and "broken". -->
        <li class="none" role="presentation" aria-live="polite">
          <p>Fetching what people have asked for…</p>
        </li>
      {:else if hits.length}
        {#each hits as r, i (r.id)}
          <li role="option" aria-selected={i === active}>
            <button type="button" class="hit" class:active={i === active} onclick={() => go(r)}>
              <span class="hit-name">
                <b>{r.name}</b>
                {#if detailOf(r)}<span class="hit-detail">{detailOf(r)}</span>{/if}
              </span>
              <span class="hit-meta">
                <span class="votes">{people(r.votes)}</span>
                {#if r.nsfw}<span class="hit-nsfw">18+</span>{/if}
              </span>
            </button>
          </li>
        {/each}
      {:else}
        <li class="none" role="presentation">
          <p>Nobody has asked for "{q}" yet.</p>
          <a class="btn btn-primary" href={`/request?name=${encodeURIComponent(q)}`}>
            Make a request
          </a>
        </li>
      {/if}
    </ul>
  {/if}
</div>

<style>
  /* Same shape as SourceFinder on the broken board, down to the class names —
     the two boards offer their search in the same place and it should look and
     behave like the one control it is. */
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
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    inline-size: 100%;
    padding: var(--space-2) var(--space-3);
    text-align: start;
  }
  .hit:hover, .hit.active { background: var(--surface-active); }
  .hit-name {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
    min-inline-size: 0;
    font-size: var(--text-sm);
  }
  /* The address of a site, or the ask of a feature. Quieter than the name
     either way, and it is the half that can be long. */
  .hit-detail { color: var(--text-tertiary); overflow-wrap: anywhere; }
  .hit-meta {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex: none;
    font-size: var(--text-sm);
  }
  .votes { color: var(--text-tertiary); white-space: nowrap; }
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
