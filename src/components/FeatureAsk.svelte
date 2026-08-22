<script lang="ts">
  import SourcePicker, { type Picked, type SourceRow } from './SourcePicker.svelte';
  import { loadRequestFeed, type FeatureRow } from '../lib/request-feed';

  /**
   * Asking for something on a source that already exists.
   *
   * The picker plus the answer to "has somebody already asked for this?", which
   * on this path cannot be a database constraint. The unique index is on
   * (source_id, kind, problem), so writing a problem key would let one open
   * feature request exist per source and silently merge the second person's
   * "add login" into the first person's "import my library" — two different
   * asks about one source are two asks. So the rows are kept distinct and this
   * panel is what stops the duplicates: pick a source and every open ask
   * against it is listed, each with the button that joins it.
   *
   * With JavaScript off there is no panel and no list, and the server still
   * takes the filing — one more row on a board where a moderator can mark a
   * duplicate, which is the same trade the rest of this form makes.
   */
  let {
    sources,
    langLabels,
    selectedId = '',
    selectedName = '',
  }: {
    sources: SourceRow[];
    langLabels: Record<string, string>;
    selectedId?: string;
    selectedName?: string;
  } = $props();

  const initial = selectedId ? sources.find((s) => s.id === selectedId) : undefined;

  let chosen = $state<SourceRow | Picked | null>(
    initial ?? (selectedId ? { id: selectedId, name: selectedName, extVersion: '' } : null),
  );
  let asks = $state.raw<FeatureRow[] | null>(null);
  let loading = $state(false);
  let failed = $state(false);
  let gate: HTMLInputElement | undefined;

  /**
   * The list is fetched once a source is picked, not on mount: before that
   * there is nothing to filter it by, and most visitors to this page are on
   * the other path entirely.
   */
  $effect(() => {
    if (!chosen || asks !== null || loading || failed) return;
    loading = true;
    loadRequestFeed().then(
      (feed) => {
        asks = feed.features;
        failed = false;
        loading = false;
      },
      () => {
        // Silent. This panel is an early warning, and a form that works beats
        // an apology for a list that did not load.
        failed = true;
        loading = false;
      },
    );
  });

  $effect(() => {
    void chosen?.id;
    if (failed) {
      failed = false;
    }
  });

  /**
   * Same reach-into-the-form trick ReportForm uses, and for the same reason:
   * without it an anonymous visitor could spend a whole Discord round trip on a
   * submission the server was always going to refuse. The page marks its send
   * button; with JavaScript off nothing here runs and the server does the
   * refusing.
   */
  $effect(() => {
    const form = gate?.form;
    if (!form) return;
    const blocked = !chosen;
    form.toggleAttribute('data-needs-source', blocked);
    for (const b of form.querySelectorAll<HTMLButtonElement>('button[data-gate="source"]')) {
      b.disabled = blocked;
    }
  });

  const mine = $derived(
    chosen && asks ? asks.filter((a) => a.sourceId === chosen!.id) : [],
  );

  const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);
</script>

<input type="hidden" name="gate" value="" bind:this={gate} />

<div class="field">
  <span class="label" id="which-source">Which source?</span>
  <SourcePicker
    {sources}
    {langLabels}
    bind:chosen
    label="Search for the source"
    placeholder="Start typing a source name…"
  />
  <p class="field-hint">
    The extension this is about. If the site isn't in the list yet, ask for the
    source itself instead.
  </p>
</div>

{#if mine.length}
  <div class="asks" role="status">
    <p class="asks-h">Already asked for {chosen?.name}</p>
    <ul class="asks-list">
      {#each mine as a (a.id)}
        <li>
          <a class="asks-name" href={`/report/${a.id}`}>
            <b>{a.text}</b>
            <span class="asks-votes">{people(a.votes)}</span>
          </a>
          <!-- formnovalidate: joining needs neither a sentence nor anything
               else the server is not going to read. -->
          <button class="btn" type="submit" name="join" value={a.id} formnovalidate>
            Add my vote
          </button>
        </li>
      {/each}
    </ul>
    <p class="asks-note">If none of these is what you meant, carry on below.</p>
  </div>
{/if}

<style>
  /* astro-island is display: contents, so this sits in the page's own .flow and
     inherits its gap; the base margin between adjacent fields would be added on
     top of that. Same fix RequestFinder needed. */
  .field + .field { margin-block-start: 0; }

  .asks {
    padding: var(--space-2) var(--space-3) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--surface-inset);
    font-size: var(--text-sm);
  }
  .asks-h {
    font-weight: var(--weight-medium);
    color: var(--text-secondary);
    padding-block-end: var(--space-1);
  }
  .asks-list { display: grid; gap: var(--space-1); }
  .asks-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-block: var(--space-1);
  }
  .asks-list li + li { border-block-start: 1px solid var(--border-subtle); }
  .asks-name {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex: 1 1 auto;
    flex-wrap: wrap;
    min-inline-size: 0;
    color: var(--text-primary);
  }
  .asks-name:hover b { text-decoration: underline; text-underline-offset: 2px; }
  .asks-votes { color: var(--text-tertiary); }
  .asks-list .btn { flex: none; }
  .asks-note { padding-block-start: var(--space-2); color: var(--text-muted); }

  @media (max-width: 560px) {
    .asks-list .btn { padding-inline: var(--space-2); font-size: var(--text-sm); }
  }
</style>
