import type { ServerEvent } from '@tower/shared';
import { useStore } from './store';

let retry = 0;

export function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  const st = useStore.getState();

  ws.onopen = () => {
    retry = 0;
    st.setConnected(true);
  };
  ws.onmessage = (e) => {
    const ev = JSON.parse(e.data) as ServerEvent;
    const s = useStore.getState();
    switch (ev.type) {
      case 'snapshot':
        s.setSnapshot(ev.sessions);
        break;
      case 'session':
        s.upsertSession(ev.session);
        break;
      case 'session_removed':
        s.removeSession(ev.id);
        break;
      case 'timeline':
        s.appendTimeline(ev.item);
        break;
    }
  };
  ws.onclose = () => {
    useStore.getState().setConnected(false);
    const wait = Math.min(1000 * 2 ** retry++, 10000);
    setTimeout(connectWs, wait);
  };
  ws.onerror = () => ws.close();
}
