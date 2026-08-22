<script module lang="ts">
  import { loadRequestFeed, type RequestRow } from '../lib/request-feed';

  /** One open source request, as /requests.json describes it. */
  type Row = RequestRow;
</script>

<script lang="ts">
  import { duplicateOf, suggestRequests } from '../lib/requests';

  /**
   * The name and address fields, plus what is already on the requests board.
   *
   * Filing a site somebody has already asked for has always added you to their
   * request rather than making a second one — but only once the form was sent,
   * so from the requester's side it read as if their request had vanished into
   * someone else's. This says it while they type, and turns the answer into one
   * button: Add my vote, which submits `join` and is the whole interaction.
   *
   * The two fields live in here rather than in the page because the match reads
   * both of them: a name catches the request stored under a different URL, an
   * address catches the one stored under a different name.
   *
   * With JavaScript off nothing here runs, the fields are plain inputs, and the
   * server's own dedupe still routes a duplicate to the existing request — the
   * flow this only makes visible earlier.
   */
  let { name = '', url = '' }: { name?: string; url?: string } = $props();

  let siteName = $state(name);
  let siteUrl = $state(url);
  let rows = $state.raw<Row[] | null>(null);
  let loading = $state(false);

  /**
   * Starts the fetch, at most once per page, and only for someone using the
   * form — mounting is not intent, so /request itself never pays for the list.
   *
   * On focus *and* on input. Focus alone would be the cheaper hook, but a
   * pasted value, an autofill and a restored draft can all reach the field
   * without one, and the list is the whole point of the field.
   */
  function begin() {
    if (rows || loading) return;
    loading = true;
    loadRequestFeed().then(
      (feed) => {
        // Only the source requests: this form's question is "has somebody asked
        // for this *site*", and a feature request against an existing source is
        // never an answer to it.
        rows = feed.requests;
        loading = false;
      },
      () => {
        // Silent: a form that works is better than an apology for a list that
        // is only ever an early warning. The server still deduplicates.
        loading = false;
      },
    );
  }

  /* The one case where mounting *is* intent: the fields already have something
     in them, because this is a draft resumed after signing in or a form
     re-rendered with an error. Nobody is going to focus them again before
     pressing send, so the check has to be on screen before they do. Inside an
     effect so it stays a client-only fetch. */
  $effect(() => {
    if (name || url) begin();
  });

  /** The request this one would be merged into on submit, if it were sent now. */
  const twin = $derived(rows ? duplicateOf(rows, siteName, siteUrl) : undefined);

  /** Near misses, shown only when there is no outright twin to point at. */
  const near = $derived(
    rows && !twin ? suggestRequests(rows, siteName, siteUrl, 4) : [],
  );

  const people = (n: number) => (n === 1 ? '1 person' : `${n} people`);
</script>

<div class="field">
  <label class="label" for="name">Site name</label>
  <input
    class="input"
    id="name"
    name="name"
    bind:value={siteName}
    onfocus={begin}
    oninput={begin}
    placeholder="e.g. AnimeFire"
    autocomplete="off"
    required
  />
</div>

<div class="field">
  <label class="label" for="url">Address</label>
  <!-- Deliberately not type="url": the hint says a bare domain is fine and the
       server agrees (normaliseUrl adds the scheme), but a url input refuses
       "animefire.plus" in the browser, so the form could not be sent the way
       it asked to be filled in. -->
  <input
    class="input"
    id="url"
    name="url"
    type="text"
    inputmode="url"
    bind:value={siteUrl}
    onfocus={begin}
    oninput={begin}
    placeholder="animefire.plus"
    autocomplete="off"
    spellcheck="false"
    required
  />
  <p class="field-hint">Just the domain is fine.</p>
</div>

{#if twin}
  <div class="found" role="status">
    <p class="found-h">Someone has already asked for this</p>
    <p class="found-what">
      <b>{twin.name}</b>
      {#if twin.url}<span class="host">{twin.url}</span>{/if}
      {#if twin.nsfw}<span class="adult">18+</span>{/if}
    </p>
    <p class="found-why">
      {people(twin.votes)} asked for it so far. Add your vote and it moves up the
      board. Voting on one counts for as much as filing a new one.
    </p>
    <div class="found-row">
      <!-- formnovalidate: joining needs no language and no address, and the
           browser would otherwise refuse the click over an empty field the
           server is not going to read. -->
      <button class="btn btn-primary" type="submit" name="join" value={twin.id} formnovalidate>
        Add my vote
      </button>
      <a class="btn btn-ghost" href={`/report/${twin.id}`}>See the request</a>
    </div>
  </div>
{:else if near.length}
  <div class="near" role="status">
    <p class="near-h">Already asked for</p>
    <ul class="near-list">
      {#each near as r (r.id)}
        <li>
          <a class="near-name" href={`/report/${r.id}`}>
            <b>{r.name}</b>
            {#if r.url}<span class="host">{r.url}</span>{/if}
            {#if r.nsfw}<span class="adult">18+</span>{/if}
            <span class="near-votes">{people(r.votes)}</span>
          </a>
          <button class="btn" type="submit" name="join" value={r.id} formnovalidate>
            Add my vote
          </button>
        </li>
      {/each}
    </ul>
    <p class="near-note">If none of these is your site, carry on and send your request.</p>
  </div>
{/if}

<style>
  /* `<astro-island>` is `display: contents`, so these three blocks are flex
     items of the page's own .flow form and inherit its gap. The base.css margin
     between adjacent fields would then be added on top of that gap, which is
     what made the space between the name and the address twice everything
     else's. */
  .field + .field { margin-block-start: 0; }

  /* The twin: a decision, so it gets the quiet box the rest of the site uses
     for "read this", with the action inside it. */
  .found {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3);
    border: 1px solid var(--border-default);
    border-inline-start: 2px solid var(--signal);
    border-radius: var(--radius-md);
    background: var(--signal-fill);
    font-size: var(--text-sm);
  }
  .found-h {
    font-size: var(--text-md);
    font-weight: var(--weight-semi);
    color: var(--text-primary);
  }
  .found-what {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
    color: var(--text-primary);
  }
  .found-why { color: var(--text-secondary); }
  .found-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    margin-block-start: var(--space-1);
  }

  /* The near misses: a list, not a decision. No fill, so it does not compete
     with the twin box or with the send button. */
  .near {
    padding: var(--space-2) var(--space-3) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--surface-inset);
    font-size: var(--text-sm);
  }
  .near-h {
    font-weight: var(--weight-medium);
    color: var(--text-secondary);
    padding-block-end: var(--space-1);
  }
  .near-list { display: grid; gap: var(--space-1); }
  .near-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding-block: var(--space-1);
  }
  .near-list li + li { border-block-start: 1px solid var(--border-subtle); }
  .near-name {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-wrap: wrap;
    min-inline-size: 0;
    color: var(--text-primary);
  }
  .near-name:hover b { text-decoration: underline; text-underline-offset: 2px; }
  .near-votes { color: var(--text-tertiary); }
  .near-note {
    padding-block-start: var(--space-2);
    color: var(--text-muted);
  }

  /* The domain, in the data face, because it is a value and not prose. */
  .host { font-family: var(--font-data); color: var(--text-tertiary); overflow-wrap: anywhere; }
  /* Same red the rest of the site gives it, and it says what it means. */
  .adult { color: var(--dead); font-weight: var(--weight-medium); font-size: var(--text-xs); }

  /* The name and the host wrap inside their own cell rather than stacking the
     row: four suggestions with a full-width button under each turned the form
     into a page and a half of scrolling on a phone, and pushed the language
     field and the send button off the screen. */
  .near-name { flex: 1 1 auto; }
  .near-list .btn { flex: none; }
  @media (max-width: 560px) {
    .near-list .btn { padding-inline: var(--space-2); font-size: var(--text-sm); }
  }
</style>
