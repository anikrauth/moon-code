const http = require('http');

function chunk(delta, finish = null, usage = undefined) {
  return { id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}) };
}

function toolCallChunk(name, args, id = 'call_1', index = 0) {
  return chunk({ tool_calls: [{ index, id, type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] });
}

function textChunks(...texts) {
  return [...texts.map(t => chunk({ content: t })), chunk({}, 'stop')];
}

// Like textChunks but the final stop chunk carries an OpenAI usage payload.
function textChunksWithUsage(usage, ...texts) {
  return [...texts.map(t => chunk({ content: t })), chunk({}, 'stop', usage)];
}

// route(parsedRequestBody) -> array of chunk objects, or {status, body} for error responses
function startServer(route) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', d => raw += d);
    req.on('end', () => {
      const body = JSON.parse(raw);
      server.requests.push(body);
      const out = route(body);
      if (out && !Array.isArray(out)) {
        res.writeHead(out.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.body ?? { error: { message: 'mock error' } }));
        return;
      }
      if (body.stream !== true) {
        // Non-streaming call (e.g. generateText): synthesize a chat.completion
        // JSON from the chunk array's text deltas.
        const content = out.map(c => c.choices?.[0]?.delta?.content ?? '').join('');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'c1', object: 'chat.completion', created: 1, model: 'mock',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const p of out) res.write(`data: ${JSON.stringify(p)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  server.requests = [];
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const baseUrlOf = (server) => `http://127.0.0.1:${server.address().port}/v1`;

module.exports = { chunk, toolCallChunk, textChunks, textChunksWithUsage, startServer, baseUrlOf };
