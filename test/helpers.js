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

async function openExtensionPage(context, extensionId, pagePath = 'popup/popup.html') {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/${pagePath}`);
  return page;
}

module.exports = { rule, setState, pushRules, openExtensionPage };
