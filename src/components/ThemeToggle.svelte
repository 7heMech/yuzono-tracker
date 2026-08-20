<script lang="ts">
  // Two states, not three. "Auto" is the *starting* state, not a destination:
  // the inline script in Base.astro resolves the system preference to a real
  // theme before first paint, so this button only ever flips light ↔ dark and
  // never has to show an icon for "whatever your OS says".
  const read = (): 'light' | 'dark' =>
    typeof document === 'undefined'
      ? 'dark'
      : document.documentElement.dataset.theme === 'light'
        ? 'light'
        : 'dark';

  let mode = $state<'light' | 'dark'>(read());

  $effect(() => {
    // Until someone picks, keep following the system — a resolved theme is a
    // starting point, not a decision.
    if (localStorage.getItem('theme')) return;
    mode = read();
    const mq = matchMedia('(prefers-color-scheme: light)');
    const sync = () => {
      mode = mq.matches ? 'light' : 'dark';
      document.documentElement.dataset.theme = mode;
    };
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  });

  function toggle() {
    mode = mode === 'dark' ? 'light' : 'dark';
    localStorage.setItem('theme', mode);
    document.documentElement.dataset.theme = mode;
  }

  // The icon shows what the click does, so the button needs no legend.
  const label = $derived(mode === 'dark' ? 'Switch to light theme' : 'Switch to dark theme');
</script>

<button class="btn btn-ghost btn-icon" onclick={toggle} title={label} aria-label={label}>
  {#if mode === 'dark'}
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </svg>
  {:else}
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  {/if}
</button>
