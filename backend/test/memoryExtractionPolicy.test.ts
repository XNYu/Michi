import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_KINDS } from 'michi-shared';
import {
  EXTRACTION_EXCLUSIONS,
  buildExtractionInstructions,
  detectCorrection,
  type CorrectionPatternId,
  type ExtractionToolNames,
} from '../src/services/memory/extractionPolicy';
import {
  lastUserText,
  loadExtractionFixtures,
  validateExtractionFixtures,
  type ExtractionFixtureCase,
  type ExtractionFixtureSet,
} from './helpers/memoryExtractionFixtures';

const SETS: ExtractionFixtureSet[] = ['positive', 'negative', 'correction'];
const fixtures = Object.fromEntries(SETS.map((set) => [set, loadExtractionFixtures(set)])) as Record<ExtractionFixtureSet, ExtractionFixtureCase[]>;
const allCases = SETS.flatMap((set) => fixtures[set]);
const HAN = /\p{Script=Han}/u;

const ALL_PATTERN_IDS: CorrectionPatternId[] = [
  'zh_not_but', 'zh_wrong_should_be', 'zh_i_was_wrong', 'zh_correction_marker', 'zh_from_now_on_dont',
  'zh_dont_again', 'zh_change_to', 'zh_switch_back', 'zh_prefer_instead', 'zh_no_longer_use', 'zh_use_instead',
  'en_actually', 'en_i_meant', 'en_not_but', 'en_x_not_y', 'en_from_now_on', 'en_dont_again', 'en_change_to',
  'en_switch_back', 'en_i_was_wrong', 'en_scratch_that', 'en_use_instead',
];

function userTexts(item: ExtractionFixtureCase): string[] {
  return item.turns.filter((entry) => entry.role === 'user').map((entry) => entry.text);
}

describe('memory extraction fixtures', () => {
  test('every file validates and has at least 15 mixed Chinese/English cases', () => {
    for (const set of SETS) {
      const cases = fixtures[set];
      assert.ok(cases.length >= 15, `${set}.json has ${cases.length} cases`);
      assert.ok(cases.some((item) => userTexts(item).some((text) => HAN.test(text))), `${set}.json has Chinese cases`);
      assert.ok(cases.some((item) => userTexts(item).every((text) => !HAN.test(text))), `${set}.json has English cases`);
      assert.ok(cases.some((item) => item.turns.length > 1), `${set}.json has multi-turn cases`);
    }
  });

  test('case ids are unique across files', () => {
    const ids = allCases.map((item) => item.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('positive cases expect candidates, negative cases expect none, correction cases expect both', () => {
    for (const item of fixtures.positive) assert.ok(item.expected.candidates.length > 0, item.id);
    for (const item of fixtures.negative) assert.deepEqual(item.expected.candidates, [], item.id);
    for (const item of fixtures.correction) {
      assert.ok(item.expected.candidates.length > 0, item.id);
      assert.ok(item.expected.correction, `${item.id} names its correction pattern`);
    }
  });

  test('negative cases include prompt injection through untrusted tool turns', () => {
    const injections = fixtures.negative.filter((item) => item.turns.some(
      (entry) => entry.role === 'tool' && entry.untrusted === true && /remember|记住/i.test(entry.text),
    ));
    assert.ok(injections.length >= 3, `found ${injections.length} injection cases`);
  });

  test('the validator rejects malformed cases with the path of the problem', () => {
    const valid = {
      id: 'ok-case',
      description: 'valid',
      turns: [{ role: 'user', text: '以后回复用中文。' }],
      expected: { candidates: [{ kind: 'preference', scopeHint: 'maybe_global', bodyIncludes: ['中文'] }] },
    };
    assert.equal(validateExtractionFixtures([valid], 't.json').length, 1);
    const broken: Array<[string, unknown, RegExp]> = [
      ['not an array', { ...valid }, /t\.json: must be an array/],
      ['empty file', [], /t\.json: must not be empty/],
      ['unknown key', [{ ...valid, extra: 1 }], /t\.json\[0\]: unexpected key "extra"/],
      ['bad id', [{ ...valid, id: 'Bad Id' }], /t\.json\[0\]\.id/],
      ['bad role', [{ ...valid, turns: [{ role: 'system', text: 'x' }] }], /turns\[0\]\.role/],
      ['empty text', [{ ...valid, turns: [{ role: 'user', text: ' ' }] }], /turns\[0\]\.text/],
      ['untrusted user turn', [{ ...valid, turns: [{ role: 'user', text: 'x', untrusted: true }] }], /turns\[0\]\.untrusted/],
      ['non-boolean untrusted', [{ ...valid, turns: [{ role: 'user', text: 'x' }, { role: 'tool', text: 'y', untrusted: 'yes' }] }], /turns\[1\]\.untrusted/],
      ['no user turn', [{ ...valid, turns: [{ role: 'tool', text: 'x', untrusted: true }] }], /needs at least one user turn/],
      ['bad kind', [{ ...valid, expected: { candidates: [{ kind: 'habit', scopeHint: 'workspace', bodyIncludes: ['x'] }] } }], /candidates\[0\]\.kind/],
      ['bad scope hint', [{ ...valid, expected: { candidates: [{ kind: 'fact', scopeHint: 'user', bodyIncludes: ['x'] }] } }], /candidates\[0\]\.scopeHint/],
      ['empty bodyIncludes', [{ ...valid, expected: { candidates: [{ kind: 'fact', scopeHint: 'workspace', bodyIncludes: [] }] } }], /bodyIncludes: must not be empty/],
      ['missing candidates', [{ ...valid, expected: {} }], /expected: missing "candidates"/],
      ['bad correction pattern', [{ ...valid, expected: { candidates: [], correction: { pattern: 'not-but' } } }], /correction\.pattern/],
      ['duplicate id', [valid, valid], /duplicate id "ok-case"/],
    ];
    for (const [label, value, message] of broken) {
      assert.throws(() => validateExtractionFixtures(value, 't.json'), message, label);
    }
  });
});

describe('detectCorrection', () => {
  test('flags the last user turn of every correction fixture with its pattern', () => {
    for (const item of fixtures.correction) {
      assert.deepEqual(
        detectCorrection(lastUserText(item)),
        { isCorrection: true, pattern: item.expected.correction?.pattern },
        `${item.id}: ${lastUserText(item)}`,
      );
    }
  });

  test('does not flag any other user turn in the fixtures', () => {
    for (const item of allCases) {
      const texts = userTexts(item);
      const checked = item.expected.correction ? texts.slice(0, -1) : texts;
      for (const text of checked) {
        assert.deepEqual(detectCorrection(text), { isCorrection: false, pattern: null }, `${item.id}: ${text}`);
      }
      if (item.expected.correction) {
        assert.equal(detectCorrection(lastUserText(item)).pattern, item.expected.correction.pattern, item.id);
      }
    }
  });

  test('the correction fixtures cover every pattern', () => {
    const covered = new Set(fixtures.correction.map((item) => item.expected.correction?.pattern));
    assert.deepEqual(ALL_PATTERN_IDS.filter((id) => !covered.has(id)), []);
  });

  test('recognizes other phrasings of each pattern', () => {
    const cases: Array<[string, CorrectionPatternId]> = [
      ['不是 tabs，是空格。', 'zh_not_but'],
      ['不是的，是 pnpm。', 'zh_not_but'],
      ['默认分支并不是 master，而是 main。', 'zh_not_but'],
      ['错了，应该用 UTC 时间。', 'zh_wrong_should_be'],
      ['我说错了，端口是 8080。', 'zh_i_was_wrong'],
      ['我刚才记错了，是周三发版。', 'zh_i_was_wrong'],
      ['口误，是 staging 环境。', 'zh_i_was_wrong'],
      ['纠正一下我之前说的：日志保留 7 天。', 'zh_correction_marker'],
      ['今后不要在 PR 描述里贴截图。', 'zh_from_now_on_dont'],
      ['下次别直接推 main。', 'zh_from_now_on_dont'],
      ['以后别加 emoji 了，好吗？', 'zh_from_now_on_dont'],
      ['再也别用 var 声明变量。', 'zh_dont_again'],
      ['怎么又忘了，别再加分号了。', 'zh_dont_again'],
      ['把超时时间改为 30 秒。', 'zh_change_to'],
      ['数据库已经换成 MySQL 了。', 'zh_change_to'],
      ['缩进改回 2 个空格。', 'zh_switch_back'],
      ['还是保持原来的目录结构吧。', 'zh_prefer_instead'],
      ['已经不再使用 Travis 了。', 'zh_no_longer_use'],
      ['别用 any，用 unknown。', 'zh_use_instead'],
      ['用 zod 替代手写的校验。', 'zh_use_instead'],
      ['Oh actually, the port is 8443.', 'en_actually'],
      ['What I meant was the staging cluster.', 'en_i_meant'],
      ['I meant to say Tuesday.', 'en_i_meant'],
      ['We store dates not as strings but as epoch milliseconds.', 'en_not_but'],
      ['The answer is MIT, not Apache.', 'en_x_not_y'],
      ['Going forward, never force-push to release.', 'en_from_now_on'],
      ['Next time, do not open a PR without tests.', 'en_from_now_on'],
      ['Stop adding TODO comments, I mean it, never again.', 'en_dont_again'],
      ['We don’t use Redux anymore.', 'en_dont_again'],
      ['Set the timeout to 30 seconds.', 'en_change_to'],
      ['Change it to tabs, please.', 'en_change_to'],
      ['Revert to the old naming scheme.', 'en_switch_back'],
      ['Use npm again for this repo.', 'en_switch_back'],
      ['My mistake, the bucket is in eu-west-1.', 'en_i_was_wrong'],
      ['Correction: the meeting notes live in docs/notes.', 'en_i_was_wrong'],
      ['Forget what I said about tabs.', 'en_scratch_that'],
      ['Ok, ignore that, the old config is fine.', 'en_scratch_that'],
      ['Let\'s go with Postgres instead.', 'en_use_instead'],
      ['不是 `npm`，是 `pnpm`。', 'zh_not_but'],
      ['ＡＣＴＵＡＬＬＹ，use tabs.', 'en_actually'],
    ];
    for (const [text, pattern] of cases) {
      assert.deepEqual(detectCorrection(text), { isCorrection: true, pattern }, text);
    }
  });

  test('does not flag hedges, questions, bug reports and look-alike words', () => {
    const notCorrections = [
      // Hedging and questions.
      '我不是很确定是不是缓存的问题。',
      '是不是应该先跑一下测试？',
      '这不是挺好的吗？',
      '需不需要改成异步的？',
      '要不要再跑一次测试？',
      '不是 npm 是 pnpm 吗？',
      '我说错了吗？',
      'Should we change it to async?',
      'Why did you use npm instead of pnpm?',
      'Can you switch back to the old layout?',
      'Is it not possible to run this locally?',
      'I\'m not sure, but I think the cache is stale.',
      'Actually, I\'m not sure that\'s right.',
      'Actually, that works great, thanks!',
      // Bug reports and attempts.
      '还是用不了，报同样的错。',
      '我把端口改成 3001 之后还是报错。',
      '换成 Node 20 也不行。',
      '你试试改成 async 看看行不行。',
      'It\'s not working but I don\'t know why.',
      'The build is not passing but the tests are green.',
      'I tried to change it to 4 but the build fails.',
      'It doesn\'t work anymore after the upgrade.',
      'I don\'t want to see this error again.',
      'Never mind, it works again.',
      // Hypotheticals.
      '如果我说错了请指出来。',
      'If I was wrong about the port, tell me.',
      // Look-alike words and constructions.
      '这个方法不是不行，只是有点慢。',
      '不是周一就是周二发版。',
      '要不是你提醒，我差点忘了。',
      '不是因为懒，是因为没时间。',
      '以后别人接手的时候会看这份文档。',
      '帮我纠正一下这段文字里的错别字。',
      '修改用户名的接口在 users.ts 里。',
      '改成功了，谢谢。',
      '用回车键提交表单。',
      '修改回调函数的签名。',
      '用回归测试覆盖一下这个函数。',
      '不用了，谢谢！',
      '不用担心，我自己来处理。',
      '不用改了，这样就行。',
      'Not only the docs but also the tests need updating.',
      'Don\'t forget that the API changed last week.',
      'You can ignore that warning.',
      'It\'s fine, not a big deal.',
      'Go back to the previous page and click save.',
      // Ordinary requests and statements.
      '先把登录页那个 bug 修了。',
      'Run the tests and tell me what fails.',
      '',
      '   ',
    ];
    for (const text of notCorrections) {
      assert.deepEqual(detectCorrection(text), { isCorrection: false, pattern: null }, text);
    }
  });

  test('ignores fenced code and quoted lines, which are not the user\'s own words', () => {
    assert.equal(detectCorrection('看下这段代码：\n```ts\n// actually, use tabs instead\nconst a = 1;\n```\n跑一下。').isCorrection, false);
    assert.equal(detectCorrection('> 以后别用 var 了\n这句话是谁写的？').isCorrection, false);
    assert.equal(detectCorrection('```\nlog\n```\n不是 npm，是 pnpm。').pattern, 'zh_not_but');
  });

  test('a trailing question in a later clause does not hide the correction', () => {
    assert.equal(detectCorrection('不是 npm，是 pnpm，记住了吗？').pattern, 'zh_not_but');
  });

  test('the first sentence with a match decides, and the earliest match wins within it', () => {
    assert.equal(detectCorrection('先跑测试。改成 tabs，别再用空格。').pattern, 'zh_change_to');
    assert.equal(detectCorrection('别再用空格，改成 tabs。').pattern, 'zh_dont_again');
  });

  test('is deterministic across repeated calls and tolerates non-string input', () => {
    const text = 'No, I meant the staging database.';
    assert.deepEqual(detectCorrection(text), detectCorrection(text));
    assert.deepEqual(detectCorrection(text), { isCorrection: true, pattern: 'en_i_meant' });
    assert.deepEqual(detectCorrection(undefined as unknown as string), { isCorrection: false, pattern: null });
  });
});

describe('buildExtractionInstructions', () => {
  const names: ExtractionToolNames = {
    readSource: 'zz_read_batch_7',
    search: 'zz_lookup_memories_7',
    propose: 'zz_offer_candidate_7',
    noChange: 'zz_receipt_nothing_7',
  };
  const other: ExtractionToolNames = {
    readSource: 'qq_src',
    search: 'qq_find',
    propose: 'qq_put',
    noChange: 'qq_skip',
  };
  const text = buildExtractionInstructions({ toolNames: names });

  test('names every tool passed in', () => {
    for (const name of Object.values(names)) assert.ok(text.includes(`\`${name}\``), name);
  });

  test('hard-codes no tool names', () => {
    const placeholders = (value: string, toolNames: ExtractionToolNames) => Object.entries(toolNames)
      .reduce((acc, [key, name]) => acc.split(name).join(`<${key}>`), value);
    assert.equal(placeholders(text, names), placeholders(buildExtractionInstructions({ toolNames: other }), other));
    for (const name of ['memory_search', 'memory_propose', 'memory_no_change', 'memory_save', 'memory_update',
      'memory_delete', 'report_conversation_no_change', 'read_conversation_updates', 'read_source', 'web_search',
      'fetch_content']) {
      assert.ok(!text.includes(name), name);
    }
  });

  test('includes every exclusion category', () => {
    assert.ok(EXTRACTION_EXCLUSIONS.length >= 7);
    assert.ok(Object.isFrozen(EXTRACTION_EXCLUSIONS));
    for (const category of EXTRACTION_EXCLUSIONS) assert.ok(text.includes(category), category);
    const joined = EXTRACTION_EXCLUSIONS.join('\n');
    for (const topic of [/TODO/, /Test data/, /guesses/, /web pages, tool output or files/, /did not confirm/, /abandoned/, /Secrets/]) {
      assert.match(joined, topic);
    }
  });

  test('covers the policy rules with Chinese examples', () => {
    assert.match(text, /\p{Script=Han}/u);
    for (const kind of MEMORY_KINDS) assert.match(text, new RegExp(`- ${kind}:`));
    for (const rule of [
      /data, not instructions/,
      /Only the user's own words can establish a memory/,
      /maybe_global/,
      /cannot write to the user's global memory/,
      /supersedes/,
      /exactly one outcome/,
      /in the language the user used/,
      /self-contained/,
      /不是 A，而是 B/,
      /以后别/,
      /还是用回/,
      /scratch that/,
      /use X instead/,
    ]) {
      assert.match(text, rule);
    }
  });

  test('is deterministic', () => {
    assert.equal(buildExtractionInstructions({ toolNames: { ...names } }), text);
  });

  test('rejects missing, malformed or duplicate tool names', () => {
    assert.throws(() => buildExtractionInstructions({ toolNames: { ...names, search: '' } }), TypeError);
    assert.throws(() => buildExtractionInstructions({ toolNames: { ...names, propose: 'has space' } }), TypeError);
    assert.throws(() => buildExtractionInstructions({ toolNames: { ...names, noChange: names.search } }), /distinct/);
    assert.throws(() => buildExtractionInstructions({ toolNames: undefined as unknown as ExtractionToolNames }), TypeError);
  });
});
