let seq = 0;

/** Builds a valid Rule; override any field. `response` is merged, not replaced. */
function rule(overrides = {}) {
  seq += 1;
  const { response, ...rest } = overrides;
  return {
    id: `r${seq}`,
    enabled: true,
    name: `Rule ${seq}`,
    method: 'ANY',
    url: '/mocked',
    ...rest,
    response: { status: 200, headers: [], body: '{"mocked":true}', delay: 0, ...(response || {}) },
  };
}

/** Writes the extension state through the service worker (the bridge then pushes it to pages). */
async function setState(serviceWorker, { globalEnabled = true, rules = [] } = {}) {
  await serviceWorker.evaluate((state) => chrome.storage.local.set({ state }), { version: 1, globalEnabled, rules });
}

/** Engine-only tests: post RULES straight into the page, bypassing bridge and storage. */
async function pushRules(page, rules) {
  const payload = rules.map(({ id, method, url, response }) => ({ id, method, url, response }));
  await page.evaluate(async (r) => {
    window.postMessage({ type: '__API_MOCK__/RULES', rules: r }, '*');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }, payload);
}

async function openExtensionPage(context, extensionId, pagePath = 'devtools.html') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
  return page;
}

/** The id of the (single) tab the service worker keeps counters for. */
async function tabIdOf(serviceWorker) {
  const s = await serviceWorker.evaluate(() => chrome.storage.session.get(null));
  const key = Object.keys(s).find((k) => k.startsWith('tab:'));
  return key ? Number(key.slice(4)) : null;
}

/** Opens a real page (with the bridge) and waits until the service worker has registered its tab. */
async function openPageWithTab(context, server, serviceWorker, path = '/') {
  const page = await context.newPage();
  await page.goto(server.origin + path);
  let tabId = null;
  for (let i = 0; i < 50 && tabId === null; i++) {
    tabId = await tabIdOf(serviceWorker);
    if (tabId === null) await page.waitForTimeout(100);
  }
  return { page, tabId };
}

module.exports = { rule, setState, pushRules, openExtensionPage, tabIdOf, openPageWithTab };
