// The player's crash screen. If BGM Mode fails while the player page starts (one of its own scripts doesn't load,
// or an error is thrown before the page has shown anything), the page would be left empty; this puts the error
// screen (src/error.css) over it instead: what happened, Reload, and the way back. It is a plain script loaded
// before the app's modules, so it works even when they don't. The app calls window.bgmStarted() once its first
// screen is up: errors after that are the app's own to show (as notices), and a screen shown too early comes down.
(() => {
  const WATCHDOG_MS = 15000; // a page that hasn't started by then is stuck (a script that never arrived)
  let started = false;
  let screen = null;

  const ours = (url) => {
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  };

  const make = (tag, className, text) => {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text; // the detail is an error message: text, never HTML
    return node;
  };

  function show(detail) {
    if (started || screen) return;
    const build = () => {
      if (started || screen) return;
      if (!document.querySelector('link[href$="error.css"]')) {
        const css = document.createElement('link');
        css.rel = 'stylesheet';
        css.href = new URL('src/error.css', document.baseURI).href;
        document.head.append(css);
      }
      screen = make('main', 'bgm-err');
      screen.setAttribute('role', 'alert');
      const inner = make('div', 'bgm-err__inner');
      const deck = make('div', 'bgm-err__deck');
      deck.setAttribute('aria-hidden', 'true');
      deck.append(make('span', 'bgm-err__record'), make('span', 'bgm-err__arm'));
      const reload = make('button', 'bgm-err__btn bgm-err__btn--gold', 'Reload');
      reload.type = 'button';
      reload.addEventListener('click', () => location.reload());
      const home = make('a', 'bgm-err__btn', 'Back to the start');
      home.href = new URL('./', document.baseURI).href;
      const actions = make('div', 'bgm-err__actions');
      actions.append(reload, home);
      inner.append(
        deck,
        make('p', 'bgm-err__code', 'Something went wrong'),
        make('h1', 'bgm-err__title', 'The music stopped'),
        make('p', 'bgm-err__text', 'BGM Mode hit a problem while starting. Reloading usually fixes it.'),
      );
      if (detail) inner.append(make('p', 'bgm-err__detail', detail));
      inner.append(actions);
      screen.append(inner);
      document.body.append(screen);
      reload.focus();
    };
    if (document.body) build();
    else document.addEventListener('DOMContentLoaded', build, { once: true });
  }

  const watchdog = setTimeout(() => show('BGM Mode didn’t finish starting.'), WATCHDOG_MS);

  window.bgmStarted = () => {
    started = true;
    clearTimeout(watchdog);
    screen?.remove();
    screen = null;
  };

  addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (target instanceof HTMLScriptElement) {
        if (ours(target.src)) show(`Couldn’t load ${new URL(target.src).pathname}`); // one of BGM Mode's own scripts
        return;
      }
      if (target instanceof Element) return; // an image or a stylesheet that didn't load: the page still works
      if (event instanceof ErrorEvent && (!event.filename || ours(event.filename))) show(event.message); // our code threw
    },
    true,
  );
  addEventListener('unhandledrejection', (event) => show(String(event.reason?.message || event.reason || 'An unknown error')));
})();
