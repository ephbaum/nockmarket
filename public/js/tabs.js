// Hand-written tab switcher for the 4-tab portfolio page — replaces
// Bootstrap's `data-toggle="tab"`. Each `[role="tab"]` button names the
// panel it controls via `data-tab`, which is that panel's element id.
export function initTabs(root = document) {
  const tabButtons = [...root.querySelectorAll('[role="tab"]')];
  if (tabButtons.length === 0) {
    return;
  }

  function activate(button) {
    for (const tabButton of tabButtons) {
      const selected = tabButton === button;
      tabButton.setAttribute('aria-selected', String(selected));
      const panel = document.getElementById(tabButton.dataset.tab);
      if (panel) {
        panel.hidden = !selected;
      }
    }
  }

  for (const tabButton of tabButtons) {
    tabButton.addEventListener('click', () => activate(tabButton));
  }

  activate(tabButtons[0]);
}
