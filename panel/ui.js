// UI-only state shared by the panel modules. Mutated in place, never persisted.
export const ui = {
  tabId: null, // tab whose log is shown
  selectedId: null, // rule open in the editor
  query: '', // list search text
  drafts: new Map(), // id -> Rule that is not saved yet (new rules that are still invalid)
  unsaved: new Set(), // ids of saved rules with pending invalid edits
};

const listeners = new Set();
export const onUiChange = (fn) => listeners.add(fn);
export const uiChanged = () => listeners.forEach((fn) => fn());
