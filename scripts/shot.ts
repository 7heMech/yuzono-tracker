/**
 * Screenshot pages under real device emulation.
 *
 * Chromium's `--window-size` clamps to a 500px minimum and headless desktop
 * never matches `pointer: coarse`, so CLI flags cannot review a phone layout.
 * This drives the DevTools protocol instead, which sets the true layout
 * viewport, DPR, touch support and mobile flag.
 *
 *   bun scripts/shot.ts /new /              # default: iPhone-ish 390x844
 *   bun scripts/shot.ts --w 768 --h 1024 /  # tablet
 *   bun scripts/shot.ts --desktop /
 */

const argv = process.argv.slice(2);
const flag = (name: string, fallback: number) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  argv.splice(i, 2);
  return Number.isFinite(v) ? v : fallback;
};

const desktop = argv.includes('--desktop');
if (desktop) argv.splice(argv.indexOf('--desktop'), 1);
const full = argv.includes('--full');
if (full) argv.splice(argv.indexOf('--full'), 1);

const width = flag('w', desktop ? 1280 : 390);
const height = flag('h', desktop ? 900 : 844);
const dpr = flag('dpr', desktop ? 1 : 3);
const base = process.env.SHOT_BASE ?? 'http://localhost:4321';
const outDir = process.env.SHOT_DIR ?? '.';
const paths = argv.length ? argv : ['/'];

const PORT = 9333;
// A throwaway profile per run. Chromium's default profile keeps a persistent
// HTTP cache, and Network.setCacheDisabled is lost across the about:blank →
// http process swap — which silently serves a stale page and invalidates the
// entire review.
const profile = `/tmp/yt-shot-${Bun.hash(String(Date.now())).toString(36)}`;
const chrome = Bun.spawn(
  [
    'chromium',
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    `--user-data-dir=${profile}`,
    '--disk-cache-size=1',
    `--remote-debugging-port=${PORT}`,
    '--remote-allow-origins=*',
    'about:blank',
  ],
  { stdout: 'ignore', stderr: 'ignore' },
);

async function waitForDevTools() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('devtools endpoint never came up');
}

await waitForDevTools();

type Msg = { id: number; result?: any; error?: { message: string } };

class Session {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<number, (m: Msg) => void>();
  #events = new Map<string, () => void>();

  constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.id && this.#pending.has(msg.id)) {
        this.#pending.get(msg.id)!(msg);
        this.#pending.delete(msg.id);
      } else if (msg.method && this.#events.has(msg.method)) {
        this.#events.get(msg.method)!();
        this.#events.delete(msg.method);
      }
    });
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.#id;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, (m) =>
        m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result),
      );
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  once(event: string): Promise<void> {
    return new Promise((resolve) => this.#events.set(event, resolve));
  }
}

const targets = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()) as {
  type: string;
  webSocketDebuggerUrl: string;
}[];
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('no page target');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((r) => ws.addEventListener('open', () => r()));
const s = new Session(ws);

await s.send('Page.enable');
// Without this, a stale stylesheet silently invalidates the whole review — it
// fooled me twice before the harness existed.
await s.send('Network.enable');
await s.send('Network.setCacheDisabled', { cacheDisabled: true });
await s.send('Emulation.setDeviceMetricsOverride', {
  width,
  height,
  deviceScaleFactor: dpr,
  mobile: !desktop,
  screenWidth: width,
  screenHeight: height,
});
if (!desktop) {
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s.send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
}

for (const p of paths) {
  // Cache-buster as well as belt and braces: a stale stylesheet is the one
  // failure mode that makes a screenshot review actively misleading.
  const raw = p.startsWith('http') ? p : base + p;
  const url = raw + (raw.includes('?') ? '&' : '?') + `_cb=${Date.now()}`;
  await s.send('Network.setCacheDisabled', { cacheDisabled: true });
  const loaded = s.once('Page.loadEventFired');
  await s.send('Page.navigate', { url });
  await loaded;
  await new Promise((r) => setTimeout(r, 700)); // let islands hydrate

  // Report anything wider than the viewport — the usual cause of a phone layout
  // that looks fine in a desktop window.
  const probe = await s.send('Runtime.evaluate', {
    expression: `(() => {
      const d = document.documentElement;
      // Ignore anything inside a deliberately scrollable container — a chip row
      // that scrolls sideways is not a layout bug.
      const scrollable = (el) => {
        for (let p = el.parentElement; p; p = p.parentElement) {
          const o = getComputedStyle(p).overflowX;
          if ((o === 'auto' || o === 'scroll') && p.scrollWidth > p.clientWidth) return true;
        }
        return false;
      };
      const over = [...document.querySelectorAll('body *')]
        .filter(el => el.getBoundingClientRect().right > d.clientWidth + 1 && !scrollable(el))
        .slice(0, 8)
        .map(el => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).split(' ')[0] : '') +
             ' → ' + Math.round(el.getBoundingClientRect().right) + 'px');
      return JSON.stringify({
        viewport: innerWidth,
        scrollWidth: d.scrollWidth,
        coarse: matchMedia('(pointer:coarse)').matches,
        overflowing: over,
      });
    })()`,
    returnByValue: true,
  });
  const info = JSON.parse(probe.result.value);

  if (process.env.SHOT_EVAL) {
    const r = await s.send('Runtime.evaluate', {
      expression: process.env.SHOT_EVAL,
      returnByValue: true,
    });
    console.log('  eval:', JSON.stringify(r.result.value));
  }

  const shot = await s.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: full,
  });
  const name = `${outDir}/shot${p === '/' ? '_home' : p.replace(/\W+/g, '_')}_${width}.png`;
  await Bun.write(name, Buffer.from(shot.data, 'base64'));

  const bad = info.scrollWidth > info.viewport;
  console.log(
    `${p.padEnd(12)} viewport=${info.viewport} scrollWidth=${info.scrollWidth}` +
      ` coarse=${info.coarse} ${bad ? '⚠ OVERFLOW' : 'ok'} → ${name}`,
  );
  if (info.overflowing.length) for (const o of info.overflowing) console.log(`    ${o}`);
}

ws.close();
chrome.kill();

// Top-level await needs this file to be a module.
export {};
