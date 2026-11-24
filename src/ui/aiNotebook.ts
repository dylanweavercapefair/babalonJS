/** Minimal AI Notebook panel — opened from the project menu */
export function openAINotebook() {
  let panel = document.getElementById('ai-notebook-panel');
  if (panel) {
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    return;
  }

  panel = document.createElement('div');
  panel.id = 'ai-notebook-panel';
  panel.style.cssText = `
    position: fixed; top: 60px; right: 16px; width: 340px; max-height: 70vh;
    background: rgba(28,31,38,0.96); border: 1px solid #3a3f4b; border-radius: 16px;
    padding: 12px; overflow-y: auto; z-index: 1000; color: #e2e8f0; font-size: 12px;
    backdrop-filter: blur(8px);
  `;

  panel.innerHTML = `
    <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Bible</h3>
    <div>Log every change. No permanent edits without user Accept.</div>
    <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Map</h3>
    <div>Editor UI in src/ui/. Core in src/core/. AI Notebook: this panel.</div>
    <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Log</h3>
    <div id="ai-log">(empty)</div>
    <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Alerts</h3>
    <div id="ai-alerts">(none)</div>
    <h3 style="margin:8px 0 4px;font-size:13px;color:#94a3b8;">Code Injector</h3>
    <textarea id="ai-code" style="width:100%;height:80px;background:#1a1c20;color:#e2e8f0;border:1px solid #3a3f4b;border-radius:8px;padding:6px;font-family:monospace;font-size:11px;" placeholder="Paste code here..."></textarea><br>
    <button id="ai-preview" style="margin:4px 4px 4px 0;padding:6px 10px;border-radius:8px;border:1px solid #3a3f4b;background:#262a33;color:#e2e8f0;">Preview</button>
    <button id="ai-logbtn" style="margin:4px 4px 4px 0;padding:6px 10px;border-radius:8px;border:1px solid #3a3f4b;background:#262a33;color:#e2e8f0;">Log this</button>
  `;

  document.body.appendChild(panel);

  const log: { time: string; agent: string; summary: string }[] = [];
  const alerts: { time: string; message: string }[] = [];

  const render = () => {
    const logEl = document.getElementById('ai-log');
    const alertEl = document.getElementById('ai-alerts');
    if (logEl) logEl.innerHTML = log.map(e => `<div>${e.time} - ${e.agent}: ${e.summary}</div>`).join('') || '(empty)';
    if (alertEl) alertEl.innerHTML = alerts.map(e => `<div>${e.time} - ${e.message}</div>`).join('') || '(none)';
  };

  log.push({ time: new Date().toLocaleTimeString(), agent: 'Grok', summary: 'Opened AI Notebook' });
  render();

  document.getElementById('ai-preview')?.addEventListener('click', () => {
    const code = (document.getElementById('ai-code') as HTMLTextAreaElement)?.value || '';
    if (!code.trim()) return;
    alert('Preview staged (not applied):\n' + code.slice(0, 200));
    alerts.push({ time: new Date().toLocaleTimeString(), message: 'Code preview staged' });
    render();
  });

  document.getElementById('ai-logbtn')?.addEventListener('click', () => {
    const code = (document.getElementById('ai-code') as HTMLTextAreaElement)?.value || '';
    log.push({ time: new Date().toLocaleTimeString(), agent: 'User/AI', summary: code ? 'Logged code snippet' : 'Manual entry' });
    (document.getElementById('ai-code') as HTMLTextAreaElement).value = '';
    render();
  });
}
