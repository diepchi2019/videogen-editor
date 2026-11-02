// In-app chat: Claude edits the timeline through tools.
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, executeTool, transcribedSet } from './tools.js';
import { summarize } from './model.js';
import * as store from './store.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
let client;
let history = []; // Anthropic message format, kept server-side

const SYSTEM = `You are the editing assistant inside VideoGen, a CapCut-style video editor.
The user describes edits in natural language (any language, often Vietnamese or English); you perform them with the tools.
Rules:
- Act, don't ask, when the request is reasonably clear. Ask one short question only when it is truly ambiguous.
- Use look_at_asset to see what is in a clip when the request depends on content ("the part where...", "the best moment").
- Timeline times are seconds from the start of the final video; clip in/out are seconds within the source file.
- Captions: add_captions transcribes speech automatically. Use get_transcript to find moments by what is said.
- Use overlays (add_overlay) for picture-in-picture, logos and B-roll on top; batch_edit for many edits at once.
- After visual edits (text, captions, overlays, framing), check the result with look_at_timeline before replying.
- Short-form video defaults: 9:16, punchy cuts, titles near the top (y≈0.15) or lower third (y≈0.75), size 64-110, white text with box or outline.
- After editing, reply in 1-3 short sentences in the user's language summarising what changed. Do not dump ids unless useful.`;

export const resetChat = () => { history = []; };
export const getHistory = () => history;

function trimHistory() {
  // Keep the last ~30 messages, cutting only at a plain user text turn.
  if (history.length <= 30) return;
  let cut = history.length - 30;
  while (cut < history.length && !(history[cut].role === 'user' && typeof history[cut].content === 'string')) cut++;
  history = history.slice(cut);
}

export async function chat(userText, { onEvent } = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Start the server with ANTHROPIC_API_KEY=sk-ant-... or use the MCP server from Claude Code instead.');
  }
  client ||= new Anthropic();
  history.push({ role: 'user', content: userText });
  const actions = [];
  for (let step = 0; step < 15; step++) {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: [{ type: 'text', text: SYSTEM }, { type: 'text', text: `Current project state:\n${summarize(store.getProject(), { transcribed: transcribedSet(store.getProject()) })}` }],
      tools: TOOLS,
      messages: history,
    });
    history.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || !uses.length) {
      trimHistory();
      const reply = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      return { reply, actions };
    }
    const results = [];
    for (const u of uses) {
      const r = await executeTool(u.name, u.input, 'claude');
      const summary = typeof r.content === 'string' ? r.content : `${u.name}: ${r.content.filter((b) => b.type === 'image').length} frames`;
      actions.push({ tool: u.name, input: u.input, result: summary, error: !!r.isError });
      onEvent?.({ type: 'action', tool: u.name, result: summary, error: !!r.isError });
      results.push({ type: 'tool_result', tool_use_id: u.id, content: r.content, is_error: !!r.isError });
    }
    history.push({ role: 'user', content: results });
  }
  return { reply: 'I stopped after many steps. Tell me if you want me to continue.', actions };
}
