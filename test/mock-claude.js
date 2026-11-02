// Tiny fake Anthropic Messages API for testing the chat tool loop without an API key.
import http from 'node:http';
const PORT = Number(process.env.MOCK_PORT || 3200);
http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    const j = JSON.parse(body);
    const msgs = j.messages;
    const last = msgs[msgs.length - 1];
    const reply = (content, stop) => res.end(JSON.stringify({ id: 'msg_mock', type: 'message', role: 'assistant', model: j.model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
    res.setHeader('content-type', 'application/json');
    if (typeof last.content === 'string') return reply([{ type: 'text', text: 'Let me check.' }, { type: 'tool_use', id: 'tu1', name: 'get_timeline', input: {} }], 'tool_use');
    const tr = last.content[0];
    if (tr.tool_use_id === 'tu1') {
      const ids = [...String(tr.content).matchAll(/clip_\w+/g)].map((m) => m[0]);
      const uses = ids.slice(1).map((id, i) => ({ type: 'tool_use', id: `tu2_${i}`, name: 'set_transition', input: { clipId: id, type: 'fade', duration: 0.5 } }));
      uses.push({ type: 'tool_use', id: 'tu2_x', name: 'add_text', input: { text: 'Juju đi biển', start: 0, end: 2, y: 0.15, size: 96, box: true, animation: 'pop' } });
      return reply(uses, 'tool_use');
    }
    return reply([{ type: 'text', text: 'Đã thêm hiệu ứng fade giữa các clip và tiêu đề ở trên cùng.' }], 'end_turn');
  });
}).listen(PORT, () => console.log(`mock claude on ${PORT}`));
