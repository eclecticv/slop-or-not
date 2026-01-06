// Popup script for Slop or Not

document.addEventListener('DOMContentLoaded', () => {
  loadStats();

  // Set up reset button
  document.getElementById('reset').addEventListener('click', resetStats);

  // Refresh stats every 2 seconds while popup is open
  setInterval(loadStats, 2000);
});

function loadStats() {
  chrome.storage.local.get(['slopStats'], (result) => {
    const stats = result.slopStats || {
      total: 0,
      scores: { 1: 0, 2: 0 }
    };

    displayStats(stats);
  });
}

function displayStats(stats) {
  const total = stats.total || 0;

  // Update total
  document.getElementById('total').textContent = total;

  // Calculate and display AI content rate (level 1 = Slop)
  const aiCount = stats.scores[1] || 0;
  const aiRate = total > 0 ? Math.round((aiCount / total) * 100) : 0;
  document.getElementById('slop-rate').textContent = aiRate + '%';

  // Show/hide empty state
  const emptyState = document.getElementById('empty');
  const breakdown = document.getElementById('breakdown');

  if (total === 0) {
    if (emptyState) emptyState.style.display = 'block';
    if (breakdown) breakdown.style.display = 'none';
  } else {
    if (emptyState) emptyState.style.display = 'none';
    if (breakdown) breakdown.style.display = 'block';
  }

  // Update individual counts (2 levels: Slop, Human)
  for (let i = 1; i <= 2; i++) {
    const count = stats.scores[i] || 0;
    const el = document.getElementById(`count-${i}`);
    if (el) el.textContent = count;
  }
}

function resetStats() {
  // Simple confirmation via button state change
  const button = document.getElementById('reset');
  const originalText = button.textContent;

  if (button.dataset.confirming === 'true') {
    // Actually reset
    const emptyStats = {
      total: 0,
      scores: { 1: 0, 2: 0 }
    };

    chrome.storage.local.set({ slopStats: emptyStats }, () => {
      displayStats(emptyStats);
      button.textContent = 'Done!';
      button.dataset.confirming = 'false';

      setTimeout(() => {
        button.textContent = originalText;
      }, 1500);
    });
  } else {
    // Ask for confirmation
    button.textContent = 'Click to confirm';
    button.dataset.confirming = 'true';

    setTimeout(() => {
      if (button.dataset.confirming === 'true') {
        button.textContent = originalText;
        button.dataset.confirming = 'false';
      }
    }, 3000);
  }
}
