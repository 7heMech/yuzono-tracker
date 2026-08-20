<script lang="ts">
  // Three states, because "follow the system" is a real preference and not a
  // fallback. Cycles system → dark → light.
  let mode = $state<'system' | 'dark' | 'light'>('system');

  $effect(() => {
    const stored = localStorage.getItem('theme');
    mode = stored === 'dark' || stored === 'light' ? stored : 'system';
  });

  function cycle() {
    mode = mode === 'system' ? 'dark' : mode === 'dark' ? 'light' : 'system';
    if (mode === 'system') {
      localStorage.removeItem('theme');
      delete document.documentElement.dataset.theme;
    } else {
      localStorage.setItem('theme', mode);
      document.documentElement.dataset.theme = mode;
    }
  }

  const labels = { system: 'System theme', dark: 'Dark theme', light: 'Light theme' };
</script>

<button class="btn btn-ghost btn-icon" onclick={cycle} title={labels[mode]} aria-label={labels[mode]}>
  {#if mode === 'system'}
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <rect x="2" y="4" width="20" height="13" rx="2" /><path d="M8 21h8M12 17v4" />
    </svg>
  {:else if mode === 'dark'}
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
    </svg>
  {:else}
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">
      <circle cx="12" cy="12" r="4.5" /><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19" />
    </svg>
  {/if}
</button>
