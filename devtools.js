// Registers the panel. chrome.devtools exists only inside a DevTools window.
if (chrome.devtools && chrome.devtools.panels) {
  chrome.devtools.panels.create('API Mock', '', 'panel/panel.html');
}
