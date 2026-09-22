// Reads extension state straight from storage and re-notifies on change. Writes go through the service worker.
import { defaultState } from './rule.js';

export async function readAll(tabId) {
  const keys = tabId == null ? [] : [`log:${tabId}`, `tab:${tabId}`];
  const [local, session] = await Promise.all([
    chrome.storage.local.get(['state', 'hits']),
    keys.length ? chrome.storage.session.get(keys) : {},
  ]);
  return {
    state: local.state || defaultState(),
    hits: local.hits || {},
    log: (keys.length && session[keys[0]]) || [],
    tab: (keys.length && session[keys[1]]) || { mocked: 0, issues: 0 },
  };
}

/** Calls onChange when state, hits or this tab's log/counters change. Returns an unsubscribe function. */
export function subscribe(tabId, onChange) {
  const listener = (changes, area) => {
    if (area === 'local' && ('state' in changes || 'hits' in changes)) onChange();
    else if (area === 'session' && tabId != null && (`log:${tabId}` in changes || `tab:${tabId}` in changes)) onChange();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export const send = (message) => chrome.runtime.sendMessage(message);
