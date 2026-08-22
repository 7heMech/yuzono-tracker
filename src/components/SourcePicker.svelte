<script lang="ts">
  /**
   * Pick one source out of the catalogue, by typing part of its name.
   *
   * Lifted out of ReportForm, where it was step 1, because the request form
   * needs the same control for an ask about a source that already exists. Two
   * copies of a type-ahead would be two sets of matching rules, and the rules
   * are the part that has been tuned: prefix matches before substring matches,
   * the extension's own name searched as well as the display name (47 of 310
   * differ), and a no-hits row that offers the request form instead.
   *
   * State lives with the caller, through `bind:chosen`. ReportForm reads
   * `chosen.extVersion` to decide whether somebody is out of date, which is the
   * whole reason its version gate can run before the form is ever sent — so the
   * picker cannot own that value privately.
   *
   * The hidden input is here rather than in the caller because it *is* this
   * control's output: whatever the page does with it, the field is `source`.
   */
  export type SourceRow = {
    id: string;
    name: string;
    lang: string;
    nsfw: boolean;
    extName: string;
    extVersion: string;
  };

  /** What a picked source has to answer, whether or not it came from the list. */
  export type Picked = { id: string; name: string; extVersion: string };

  let {
    sources,
    langLabels,
    chosen = $bindable(null),
    label = 'Search for the source',
    placeholder = 'Start typing a source name…',
  }: {
    sources: SourceRow[];
    langLabels: Record<string, string>;
    chosen?: SourceRow | Picked | null;
    label?: string;
    placeholder?: string;
  } = $props();

  let q = $state('');
  let active = $state(0);
  let input: HTMLInputElement | undefined;

  const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

  const hits = $derived.by(() => {
    const n = norm(q);
    if (n.length < 2) return [];
    const starts: SourceRow[] = [];
    const contains: SourceRow[] = [];
    for (const s of sources) {
      const name = norm(s.name);
      if (name.startsWith(n)) starts.push(s);
      else if (name.includes(n) || norm(s.extName).includes(n)) contains.push(s);
    }
    return [...starts, ...contains].slice(0, 7);
  });

  function pick(s: SourceRow) {
    chosen = s;
    q = '';
  }

  function clear() {
    chosen = null;
    q = '';
    requestAnimationFrame(() => input?.focus());
  }

  // Keep the highlight in bounds when the query changes: typing narrows the
  // list, and without this a stale index can point past the end.
  $effect(() => {
    void hits.length;
    active = 0;
  });

  function onKey(e: KeyboardEvent) {
    if (!hits.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = (active + 1) % hits.length; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = (active - 1 + hits.length) % hits.length; }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const chosenHit = hits[active];
      if (chosenHit) pick(chosenHit);
    }
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
      {placeholder}
      aria-label={label}
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
            Not in this repo.
            <a href={`/request?name=${encodeURIComponent(q)}`}>Request it</a> instead.
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
