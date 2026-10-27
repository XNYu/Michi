// Real JSON-RPC stdio fixture. No test replaces manager/bridge/SDK internals.
const fs = require('node:fs');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const mode = process.argv[2];
const schema = {
  type: 'object', additionalProperties: false,
  $defs: { count: { type: 'integer', minimum: 1, maximum: 4 } },
  properties: {
    count: { $ref: '#/$defs/count' },
    query: { type: 'string', minLength: 2, maxLength: 4, pattern: '^[a-z]+$' },
    tags: { type: 'array', minItems: 1, maxItems: 2, items: { type: 'string', minLength: 1 } },
    choice: { oneOf: [{ const: 'auto' }, { type: 'integer', minimum: 1 }] },
    nullable: { anyOf: [{ type: 'null' }, { type: 'string' }] },
    mode: { enum: ['normal', 'strict'] }, extra: { type: 'string' },
    __tool_use_purpose: { type: 'string' },
  }, required: ['count', 'query', 'tags', 'choice'],
  if: { properties: { mode: { const: 'strict' } }, required: ['mode'] }, then: { required: ['extra'] },
};
const tool = (name, inputSchema = { type: 'object', additionalProperties: true }) => ({ name, description: name, inputSchema });
const server = new Server({ name: 'consistency-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  if (mode === 'fail-once' && !fs.existsSync(process.argv[3])) {
    fs.writeFileSync(process.argv[3], 'failed'); throw new Error('transient discovery failure');
  }
  if (mode === 'metadata-pages') return request.params?.cursor
    ? { tools: [tool('last')] }
    : { tools: [
        { ...tool('output-first'), outputSchema: { type: 'object', properties: { answer: { type: 'integer' } }, required: ['answer'] } },
        { ...tool('task-first'), execution: { taskSupport: 'required' } },
        tool('call-log'),
      ], nextCursor: 'last-page' };
  if (mode === 'pagination') return request.params?.cursor
    ? { tools: [tool('rich', schema), tool('environment')] }
    : { tools: [tool('echo')], nextCursor: 'page-2' };
  if (mode === 'repeat-cursor') return { tools: [tool(request.params?.cursor ? 'b' : 'a')], nextCursor: 'same' };
  if (mode === 'page-fail' && request.params?.cursor) throw new Error('second page failed');
  if (mode === 'page-fail') return { tools: [tool('partial')], nextCursor: 'page-2' };
  return { tools: [tool('rich', schema), tool('environment'), tool('echo')] };
});
const calls = [];
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name === 'call-log') return { content: [{ type: 'text', text: JSON.stringify(calls) }] };
  calls.push(request.params.name);
  if (request.params.name === 'output-first') {
    if (request.params.arguments?.error) return { isError: true, content: [{ type: 'text', text: 'tool-level error' }] };
    if (request.params.arguments?.missing) return { content: [{ type: 'text', text: 'missing structured content' }] };
    return { content: [], structuredContent: { answer: request.params.arguments?.valid ? 42 : 'invalid' } };
  }
  if (request.params.name === 'environment') return { content: [{ type: 'text', text: JSON.stringify({
    secret: process.env.MCP_HOST_SECRET, inheritedUser: process.env.USER, inheritedLogname: process.env.LOGNAME, inheritedProfile: process.env.USERPROFILE, explicit: process.env.MCP_EXPLICIT, home: process.env.HOME,
  }) }] };
  if (request.params.name === 'echo') return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] };
  const annotations = { audience: ['assistant'], priority: 0.7 };
  const result = {
    content: [
      { type: 'text', text: 'visible', annotations, _meta: { text: true } },
      { type: 'image', data: 'aW1hZ2U=', mimeType: 'image/png', annotations, _meta: { image: true } },
      { type: 'audio', data: 'YXVkaW8=', mimeType: 'audio/wav', annotations },
      { type: 'resource', resource: { uri: 'fixture://document', text: 'resource body', mimeType: 'text/plain', _meta: { resource: true } }, annotations },
      { type: 'resource', resource: { uri: 'fixture://binary', blob: 'YmluYXJ5', mimeType: 'application/pdf' } },
      { type: 'resource_link', uri: 'fixture://link', name: 'report', title: 'Report', description: 'linked report', mimeType: 'application/pdf', size: 6, annotations, _meta: { link: true } },
    ], structuredContent: { answer: 42, nested: { ok: true } }, _meta: { trace: 'fixture-trace' }, isError: false,
  };
  if (request.params.arguments?.result === 'image-only') return { content: [result.content[1]], _meta: result._meta };
  if (request.params.arguments?.result === 'resource-only') return { content: [result.content[3]] };
  if (request.params.arguments?.result === 'structured-only') return { content: [], structuredContent: result.structuredContent };
  return result;
});
server.connect(new StdioServerTransport()).catch(() => process.exit(1));
