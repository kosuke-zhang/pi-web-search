import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostedDeepSeekExtension } from '../dist/hosted.js';

function tools(request) {
  const registered = new Map();
  createHostedDeepSeekExtension({ request })({ registerTool(tool) { registered.set(tool.name, tool); } });
  return registered;
}
const hit = { title: '官方文档', url: 'https://example.com/docs', summary: '搜索摘要', snippet: '短摘要' };

test('hosted DeepSeek search/fetch preserves upstream summaries, Markdown and citations', async () => {
  const requests = [];
  const extension = tools(async (r) => { requests.push(r); return r.operation === 'search' ? { results: [hit] } : { title: '网页', content: '# 标题\n\n$1+1=2$' }; });
  const result = await extension.get('web_search').execute('a', { query: '接口', urls: ['https://example.com/page'] });
  assert.deepEqual(requests.map(r => [r.callId, r.operation]), [['a:0', 'search'], ['a:1', 'fetch']]);
  assert.deepEqual(requests[0].body, { query: '接口', count: 10, need_content: false });
  assert.match(result.content[0].text, /搜索摘要/);
  assert.match(result.content[0].text, /\$1\+1=2\$/);
  assert.equal(result.details.sources.length, 2);
  assert.equal(result.details.provider, 'deepseek');
  assert.equal('searchResults' in result.details, false);
});

test('two sessions own independent transports; url_context never invokes a model or search', async () => {
  const calls = [];
  const a = tools(async r => { calls.push(['a', r.operation]); return { content: 'student a source' }; });
  const b = tools(async r => { calls.push(['b', r.operation]); return { content: 'student b source' }; });
  const results = await Promise.all([a, b].map(x => x.get('url_context').execute('same-id', { query: '阅读', urls: ['https://example.com'] })));
  assert.match(results[0].content[0].text, /student a/);
  assert.match(results[1].content[0].text, /student b/);
  assert.deepEqual(calls, [['a', 'fetch'], ['b', 'fetch']]);
});

test('paid request failures stop sequential fetches without retry or success-shaped partial results', async () => {
  let calls = 0;
  const extension = tools(async () => { calls++; throw new Error('budget exhausted'); });
  await assert.rejects(extension.get('url_context').execute('a', { query: '读', urls: ['https://a.test', 'https://b.test'] }), /budget exhausted/);
  assert.equal(calls, 1);
});

test('cancellation between requests prevents the next fetch and preserves the AbortSignal', async () => {
  const controller = new AbortController();
  let calls = 0;
  const extension = tools(async (_r, signal) => { assert.equal(signal, controller.signal); calls++; controller.abort(); return { results: [hit] }; });
  await assert.rejects(extension.get('web_search').execute('a', { query: '读', urls: ['https://a.test'] }, controller.signal), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('hosted strict schema rejects coercion, excess URL fanout and invalid search queries', () => {
  const tool = tools(async () => {}).get('web_search');
  for (const args of [{ query: 123 }, { query: ' ' }, { query: '字'.repeat(129) }, { query: 'ok', urls: Array(4).fill('https://a.test') }, { query: 'ok', provider: 'google' }]) {
    assert.throws(() => tool.prepareArguments(args));
  }
  assert.equal(tool.prepareArguments({ query: '字'.repeat(128) }).query.length, 128);
});
