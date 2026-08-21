<script lang="ts">
  import { isOutdated, compareVersions, isUnreadableVersion, APPS, APP_OTHER } from '../lib/version';

  // Source picking and the setup fields live in one island because they depend
  // on each other: choosing a source is what tells us the current extension
  // version, which is what makes the "you're out of date" check possible
  // before the form is ever submitted.
  type Row = {
    id: string;
    name: string;
    lang: string;
    nsfw: boolean;
    extName: string;
    extVersion: string;
  };

  let {
    sources,
    langLabels,
    selectedId = '',
    selectedName = '',
    appName = '',
    appVersion = '',
    extVersion = '',
  }: {
    sources: Row[];
    langLabels: Record<string, string>;
    selectedId?: string;
    selectedName?: string;
    appName?: string;
    appVersion?: string;
    extVersion?: string;
  } = $props();

  const initial = selectedId ? sources.find((s) => s.id === selectedId) : undefined;

  let chosen = $state<Row | { id: string; name: string; extVersion: string } | null>(
    initial ?? (selectedId ? { id: selectedId, name: selectedName, extVersion: '' } : null),
  );
  let q = $state('');
  let active = $state(0);
  // A remembered custom app name arrives as the appName itself, so anything
  // not in the list means "Other" was chosen last time.
  const known = (APPS as readonly string[]).includes(appName);
  let app = $state(appName && known ? appName : appName ? APP_OTHER : 'Anikku');
  let appOther = $state(appName && !known ? appName : '');
  // Remembered from a previous report: collapse it to a line. The extension
  // version still gets asked, because it is per-source and prefillable.
  let editingApp = $state(!(appName && appVersion));
  let appVer = $state(appVersion);
  let extVer = $state(extVersion);
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

  const latest = $derived(chosen?.extVersion ?? '');
  const unreadable = $derived(isUnreadableVersion(extVer));
  const stale = $derived(!!latest && !!extVer && isOutdated(extVer, latest));
  const ahead = $derived(!!latest && !!extVer.trim() && !unreadable && compareVersions(extVer, latest) > 0);
  const current = $derived(
    !!latest && !!extVer.trim() && !unreadable && !stale && compareVersions(extVer, latest) === 0,
  );
  const appOk = $derived(app !== APP_OTHER ? !!app : appOther.trim().length > 1);
  const ready = $derived(
    !!chosen && appOk && !!appVer.trim() && !!extVer.trim() && !stale && !unreadable,
  );

  let gate: HTMLInputElement | undefined;

  /**
   * The problem buttons are the submit buttons, and they live in the page rather
   * than in this island — so gating them means reaching out to the form.
   *
   * Worth the reach. Without it, tapping a problem before picking a source sent
   * an anonymous visitor all the way through Discord and returned them to "your
   * draft is still here" above an empty form: a full OAuth round trip spent on
   * a submission that could never succeed. The `ready` flag was already
   * computed here and posted in a hidden field that the server never read.
   *
   * With JavaScript off nothing here runs, the buttons stay live, and the
   * server's own "Pick which source this is about first" catches it — which is
   * why the message below is hidden until this effect reveals it.
   */
  $effect(() => {
    const form = gate?.form;
    if (!form) return;
    const blocked = !chosen;
    form.toggleAttribute('data-needs-source', blocked);
    for (const b of form.querySelectorAll<HTMLButtonElement>('button[name="problem"]')) {
      b.disabled = blocked;
    }
  });

  function pick(s: Row) {
    chosen = s;
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

<input type="hidden" name="source" value={chosen?.id ?? ''} bind:this={gate} />
<!-- Mirrors the client-side gate so the server can enforce it too. -->
<input type="hidden" name="ready" value={ready ? '1' : ''} />

<section class="step">
  <h2 class="step-h"><span class="step-n">1</span> Which source?</h2>

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
              Not in this repo.
              <a href={`/request?name=${encodeURIComponent(q)}`}>Request it</a> instead.
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>

<section class="step">
  <h2 class="step-h"><span class="step-n">2</span> Your setup</h2>
  <p class="step-sub">
    <span class="long">Asked once and remembered. Nearly every "broken" source turns out to be an
    old extension, so this is the fastest way to rule that out.</span>
    <span class="short">Asked once, then remembered.</span>
  </p>

  {#if !editingApp}
    <p class="remembered">
      <span>{app === APP_OTHER ? appOther : app} <b class="num">{appVer}</b></span>
      <button class="btn btn-ghost" type="button" onclick={() => (editingApp = true)}>Change</button>
      <input type="hidden" name="appName" value={app} />
      <input type="hidden" name="appNameOther" value={appOther} />
      <input type="hidden" name="appVersion" value={appVer} />
    </p>
  {/if}

  <div class="setup" class:hidden={!editingApp}>
    <div class="field">
      <label class="label" for="appName">App</label>
      <select class="select" id="appName" name="appName" bind:value={app} required>
        {#each APPS as a}<option value={a}>{a}</option>{/each}
      </select>
    </div>

    <div class="field">
      <label class="label" for="appVersion">App version</label>
      <input
        class="input"
        id="appVersion"
        name="appVersion"
        bind:value={appVer}
        placeholder="e.g. 0.18.3"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        required
      />
    </div>

    {#if app === APP_OTHER}
      <div class="field full">
        <label class="label" for="appNameOther">Which app?</label>
        <input
          class="input"
          id="appNameOther"
          name="appNameOther"
          bind:value={appOther}
          placeholder="e.g. Suwayomi, Kuukiyomi"
          autocomplete="off"
          required
        />
      </div>
    {/if}

    <div class="field full">
      <label class="label" for="extVersion">Extension version</label>
      <input
        class="input"
        id="extVersion"
        name="extVersion"
        bind:value={extVer}
        placeholder="e.g. 14.49"
        inputmode="decimal"
        autocomplete="off"
        spellcheck="false"
        aria-invalid={stale || unreadable ? 'true' : undefined}
        aria-describedby="ext-hint"
        required
      />
      <p class="field-hint" id="ext-hint">
        {#if latest && extVer.trim()}
          Latest is <b class="num">{latest}</b>. Find yours in Browse → Extensions.
        {:else}
          Find it in Browse → Extensions.
        {/if}
      </p>
    </div>
  </div>

  {#if unreadable}
    <div class="stale" role="alert">
      <p class="stale-title">Check the version number</p>
      <p>
        That doesn't look like a version — it has no digits. Find it in Browse →
        Extensions and copy the numbers, e.g. 14.49.
      </p>
    </div>
  {:else if stale}
    <!-- Caught before submitting, with the specific numbers, because "update
         first" is only actionable if you can see what you're on. -->
    <div class="stale" role="alert">
      <p class="stale-title">Update the extension first</p>
      <p>
        You're on <b class="num">{extVer}</b> and <b class="num">{latest}</b> is out.
        Most breakage is already fixed in the current version. Update, try again,
        and only report if it's still broken.
      </p>
      <p class="stale-how">
        Browse → Extensions → find {chosen?.name} → Update.
      </p>
    </div>
  {:else if ahead}
    <div class="ahead" role="status">
      <p>
        You're on <b class="num">{extVer}</b>, ahead of the catalogue's
        <b class="num">{latest}</b>. The catalogue may be behind — you can still file
        this, but mention you're ahead.
      </p>
    </div>
  {:else if current}
    <p class="field-hint current-hint" role="status">✓ You're on the latest version.</p>
  {/if}
</section>

<style>
  .step-sub .short { display: none; }
  @media (max-width: 620px) {
    .step-sub .long { display: none; }
    .step-sub .short { display: inline; }
  }
  .step-sub {
    max-inline-size: 60ch;
    margin-block: -8px var(--space-3);
    font-size: var(--text-sm);
    color: var(--text-tertiary);
  }

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

  /* Two columns at every width. `auto-fit` used to squeeze four fields onto
     one line on desktop, which is what made the labels and placeholders
     overflow their inputs. The two fields that carry long values get their own
     full-width row instead. */
  .setup {
    display: grid;
    gap: var(--space-3);
    grid-template-columns: 1fr 1fr;
    align-items: start;
  }
  .setup .full { grid-column: 1 / -1; }
  .setup.hidden { display: none; }

  .remembered {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-1) var(--space-1) var(--space-3);
    border: 1px solid var(--border-default);
    border-radius: var(--radius-md);
    background: var(--surface-inset);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .setup .field + .field { margin-block-start: 0; }

  .stale {
    display: grid;
    gap: var(--space-1);
    margin-block-start: var(--space-4);
    padding: var(--space-3);
    border: 1px solid var(--dead);
    border-inline-start-width: 2px;
    border-radius: var(--radius-md);
    background: var(--dead-fill);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .stale-title {
    font-size: var(--text-md);
    font-weight: var(--weight-semi);
    color: var(--text-primary);
  }
  .stale-how { color: var(--text-tertiary); }

  .ahead {
    display: grid;
    gap: var(--space-1);
    margin-block-start: var(--space-4);
    padding: var(--space-3);
    border: 1px solid var(--border-default);
    border-inline-start-width: 2px;
    border-radius: var(--radius-md);
    background: var(--surface-inset);
    font-size: var(--text-sm);
    color: var(--text-secondary);
  }
  .current-hint {
    margin-block-start: var(--space-3);
    color: var(--text-secondary);
  }
</style>
