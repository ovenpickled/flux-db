(function () {
  'use strict';

  const output = document.getElementById('output');
  const input = document.getElementById('cmd-input');

  const history = [];
  let historyIdx = -1;

  function printLine(text, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    output.appendChild(div);
    output.scrollTop = output.scrollHeight;
  }

  function printBlock(text, cls) {
    for (const line of text.split('\n')) printLine(line, cls);
  }

  let ws;
  let reconnectDelay = 1000;

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      printLine('(connected)', 'line-sys');
    };

    ws.onmessage = (ev) => {
      const cls = ev.data.startsWith('(error)') ? 'line-err' : undefined;
      printBlock(ev.data, cls);
    };

    ws.onclose = () => {
      printLine('(disconnected - reconnecting...)', 'line-sys');
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(15000, reconnectDelay * 2);
    };

    ws.onerror = () => ws.close();
  }
  connect();

  function submit() {
    const val = input.value;
    input.value = '';
    if (val.trim().length === 0) return;

    printLine('> ' + val, 'line-cmd');
    history.push(val);
    historyIdx = history.length;

    if (val.trim() === 'clear' || val.trim() === 'cls') {
      output.textContent = '';
      return;
    }

    if (ws.readyState === WebSocket.OPEN) {
      ws.send(val);
    } else {
      printLine('(not connected yet, try again in a moment)', 'line-sys');
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { submit(); return; }
    if (e.key === 'ArrowUp') {
      if (historyIdx > 0) { historyIdx--; input.value = history[historyIdx]; }
      e.preventDefault();
      return;
    }
    if (e.key === 'ArrowDown') {
      if (historyIdx < history.length - 1) { historyIdx++; input.value = history[historyIdx]; }
      else { historyIdx = history.length; input.value = ''; }
      e.preventDefault();
    }
  });

  input.focus();
})();