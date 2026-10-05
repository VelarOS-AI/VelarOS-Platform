import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { runInNewContext } from 'node:vm'

const variants = [
  ['main', 'dist/esm/index.js'],
  ['slim', 'dist/esm/slim.js'],
  ['browser', 'dist/browser/index.js'],
  ['browser slim', 'dist/browser/slim.js'],
  ['CommonJS main', 'dist/commonjs/index.js'],
  ['CommonJS slim', 'dist/commonjs/slim.js'],
]
const markup =
  '<main><section id="a" class="old"><i>old</i></section><section id="b"></section><aside id="outside">z</aside><input id="input" value="one"><select id="select"><option value="a" selected>A</option><option value="b">B</option></select></main>'

// This independent oracle walks the test tree. Production code is required to
// capture affected fields in mutation paths; the oracle is not an implementation.
function snapshot($) {
  const nodes = new Map()
  function visit(node) {
    nodes.set(node, {
      attributes: node.attribs ? { ...node.attribs } : null,
      children: node.children ? [...node.children] : null,
    })
    for (const child of node.children ?? []) visit(child)
  }
  visit($._root)
  return nodes
}

test('public declarations expose typed subscriptions and the change-record union', async () => {
  const directory = await mkdtemp(join(process.cwd(), '.mutation-types-'))
  try {
    const source = variants
      .map(
        ([_label, entry], index) => `
import { load as load${index}, type CheerioChangeRecord as Record${index} } from '../${entry}';
const api${index} = load${index}('<main/>');
const stop${index}: () => void = api${index}.observeChanges((records) => {
  const typed: Record${index}[] = records;
  for (const record of typed) {
    if (record.type === 'attribute') {
      const target: import('domhandler').Element = record.target;
      const name: string = record.name;
      const oldValue: string | null = record.oldValue;
      const newValue: string | null = record.newValue;
      void [target, name, oldValue, newValue];
    } else {
      const target: import('domhandler').ParentNode = record.target;
      const oldChildren: import('domhandler').AnyNode[] = record.oldChildren;
      const newChildren: import('domhandler').AnyNode[] = record.newChildren;
      void [target, oldChildren, newChildren];
    }
  }
});
stop${index}();
// @ts-expect-error Attribute record values are strings or null.
const invalid${index}: Record${index} = { type: 'attribute', target: api${index}('main')[0], name: 'x', oldValue: null, newValue: 123 };
void invalid${index};
`
      )
      .join('\n')
    const file = join(directory, 'consumer.mts')
    await writeFile(file, source)
    await promisify(execFile)(
      process.execPath,
      [
        join(process.cwd(), 'node_modules/typescript/bin/tsc'),
        '--noEmit',
        '--strict',
        '--skipLibCheck',
        '--target',
        'ES2022',
        '--module',
        'NodeNext',
        '--moduleResolution',
        'NodeNext',
        file,
      ],
      { cwd: process.cwd(), timeout: 60000, maxBuffer: 2000000 }
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('browser bundle subscriptions work without Node globals', async () => {
  const require = createRequire(join(process.cwd(), 'package.json'))
  const { build } = require('esbuild')
  const bundle = await build({
    entryPoints: [join(process.cwd(), 'dist/browser/index.js')],
    bundle: true,
    write: false,
    format: 'iife',
    globalName: 'CheerioGrade',
    platform: 'browser',
    target: 'es2020',
    logLevel: 'silent',
  })
  const result = runInNewContext(
    bundle.outputFiles[0].text +
      `
(() => {
  const a = CheerioGrade.load('<main><i>left</i></main>', null, false);
  const b = CheerioGrade.load('<main>right</main>', null, false);
  const left = [], right = [];
  const stop = a.observeChanges(rows => left.push(rows));
  b.observeChanges(rows => right.push(rows));
  const node = a('i')[0];
  a('i').attr('title', 'ready');
  b('main').append(node);
  stop();
  a('main').attr('title', 'quiet');
  return { nodeIsPreserved: b('i')[0] === node, leftBatches: left.length, rightBatches: right.length,
    firstAttribute: left[0][0].type === 'attribute' && left[0][0].newValue === 'ready',
    sourceChildren: left[1][0].type === 'children', destinationChildren: right[0][0].type === 'children',
    hasProcess: typeof process !== 'undefined', hasRequire: typeof require !== 'undefined', hasBuffer: typeof Buffer !== 'undefined' };
})()
`,
    {},
    { timeout: 10000 }
  )
  assert.equal(result.nodeIsPreserved, true)
  assert.equal(result.leftBatches, 2)
  assert.equal(result.rightBatches, 1)
  assert.equal(result.firstAttribute, true)
  assert.equal(result.sourceChildren, true)
  assert.equal(result.destinationChildren, true)
  assert.equal(result.hasProcess || result.hasRequire || result.hasBuffer, false)
})
function expectedChanges(before, after) {
  const result = []
  for (const [target, old] of before) {
    const current = after.get(target)
    if (!current) continue
    if (old.attributes && current.attributes) {
      for (const name of new Set([
        ...Object.keys(old.attributes),
        ...Object.keys(current.attributes),
      ])) {
        const oldValue = old.attributes[name] ?? null,
          newValue = current.attributes[name] ?? null
        if (oldValue !== newValue)
          result.push({ type: 'attribute', target, name, oldValue, newValue })
      }
    }
    if (
      old.children &&
      current.children &&
      (old.children.length !== current.children.length ||
        old.children.some((node, i) => node !== current.children[i]))
    )
      result.push({
        type: 'children',
        target,
        oldChildren: old.children,
        newChildren: current.children,
      })
  }
  return result
}
function compareRecords(actual, expected) {
  assert.equal(actual.length, expected.length, 'Exactly the coalesced affected fields are reported')
  const remaining = [...actual]
  for (const record of expected) {
    const at = remaining.findIndex(
      (item) =>
        item.type === record.type &&
        item.target === record.target &&
        (record.type !== 'attribute' || item.name === record.name)
    )
    assert(
      at >= 0,
      `Missing ${record.type} change for ${record.name ?? record.target.name ?? 'document'}`
    )
    const item = remaining.splice(at, 1)[0]
    if (record.type === 'attribute') {
      assert.equal(item.oldValue, record.oldValue)
      assert.equal(item.newValue, record.newValue)
    } else {
      assert.deepEqual(item.oldChildren, record.oldChildren)
      assert.deepEqual(item.newChildren, record.newChildren)
      assert.notEqual(item.newChildren, item.target.children, 'Notification arrays are snapshots')
    }
  }
}
function subscribe($, listener) {
  assert.equal(
    typeof $.observeChanges,
    'function',
    'Document mutation subscriptions must be available'
  )
  const stop = $.observeChanges(listener)
  assert.equal(typeof stop, 'function')
  return stop
}

for (const [label, entry] of variants) {
  const api = await import(pathToFileURL(join(process.cwd(), entry)))
  const load = (html = markup, options) => api.load(html, options, false)
  const check = (name, fn) => test(`${label}: ${name}`, fn)
  const family = (name, run, options = {}) =>
    check(name, () => {
      const $ = load(options.markup ?? markup, options.loadOptions)
      const batches = [],
        before = snapshot($)
      subscribe($, (records) => batches.push(records))
      const result = run($)
      const after = snapshot($),
        expected = expectedChanges(before, after)
      assert.equal(
        batches.length,
        expected.length ? 1 : 0,
        'One batch per outer mutation, no empty batches'
      )
      if (options.change !== false)
        assert(expected.length > 0, 'The scenario must change the real DOM')
      compareRecords(batches.flat(), expected)
      options.verify?.($, result)
    })

  check('ordinary DOM behavior is preserved', () => {
    const $ = load()
    $('#a').append('<em>x</em>').attr('title', 'ready')
    assert.equal($('#a').text(), 'oldx')
    assert.equal($('#a').attr('title'), 'ready')
  })
  family('single and object attribute setters', ($) =>
    $('#a').attr({ title: 'one', 'data-a': '2' })
  )
  family('multi-target callback attribute setter preserves receiver and index', ($) => {
    const targets = $('section'),
      seen = []
    const result = targets.attr('title', function (i, old) {
      seen.push([this, i, old])
      return `item-${i}`
    })
    assert.equal(result, targets)
    assert.deepEqual(
      seen.map((x) => x[1]),
      [0, 1]
    )
    assert.equal(seen[0][0], targets[0])
    return result
  })
  family('attribute removal coalesces multiple names', ($) => $('#a').removeAttr('class id'))
  family('attribute-backed prop setter', ($) => $('#input').prop('disabled', true))
  family('addClass', ($) => $('#a').addClass('new other'))
  family('removeClass callback', ($) => $('#a').removeClass((_i, old) => old))
  family('toggleClass', ($) => $('#a').toggleClass('old new'))
  family('css object setter', ($) => $('#a').css({ color: 'red', display: 'block' }))
  family('input value setter', ($) => $('#input').val('two'))
  family('select value updates option attributes', ($) => $('#select').val('b'))
  family(
    'append HTML across targets preserves actual clone identities',
    ($) => $('section').append('<strong>new</strong>'),
    {
      verify($) {
        assert.notEqual($('#a strong')[0], $('#b strong')[0])
      },
    }
  )
  family('prepend array operands', ($) => $('#a').prepend(['first', '<b>second</b>']))
  family('appendTo moves an existing node', ($) => $('#outside').appendTo('#b'))
  family('prependTo moves an existing node', ($) => $('#outside').prependTo('#a'))
  family('before callback', ($) =>
    $('#a').before(function (i) {
      assert.equal(this, $('#a')[0])
      assert.equal(i, 0)
      return '<header>h</header>'
    })
  )
  family('after node operands', ($) => $('#a').after($('<footer>f</footer>')[0]))
  family('insertBefore', ($) => $('#outside').insertBefore('#a'))
  family('insertAfter', ($) => $('#outside').insertAfter('#b'))
  family('remove filtered selections', ($) => $('section').remove('#a'))
  family('empty parent', ($) => $('#a').empty())
  family('replaceWith preserves actual replacement nodes', ($) =>
    $('#a').replaceWith($('<article>replacement</article>'))
  )
  family('html replaces child lists', ($) => $('section').html('<p>replacement</p>'))
  family('text callback replaces child lists', ($) =>
    $('section').text(function (i, old) {
      return `${i}:${old}`
    })
  )
  family('wrap', ($) => $('section').wrap('<div class="wrapper"></div>'))
  family('wrapInner', ($) => $('#a').wrapInner('<div class="inside"></div>'))
  family('wrapAll', ($) => $('section').wrapAll('<div class="all"></div>'))
  family('unwrap', ($) => $('#a i').unwrap())
  family('document-root edits', ($) => $.root().append('<summary>end</summary>'))
  family('same-parent movement preserves ordering in snapshots', ($) => $('#a').appendTo('main'))
  family('XML preserves case-sensitive attribute names', ($) => $('Item').attr('Flag', 'two'), {
    markup: '<Root><Item Flag="one"/></Root>',
    loadOptions: { xml: true },
  })
  family(
    'getters traversal serialization clones and data cache remain quiet',
    ($) => {
      $('#a').attr('class')
      $('#input').prop('value')
      $('#a').css()
      $('#input').val()
      $('main').find('section').first().parents()
      $.html()
      $('#a').html()
      $('#a').text()
      $('#a').clone().attr('title', 'detached')
      $('#a').data('cache', { n: 1 })
    },
    { change: false }
  )
  family(
    'unchanged attributes and empty selections remain quiet',
    ($) => {
      $('#a').attr('class', 'old')
      $('#missing').attr('x', 'one').append('<b>x</b>')
    },
    { change: false }
  )
  family(
    'nested attribute changes that return to the starting value coalesce away',
    ($) => {
      $('#a').attr('class', function (_i, old) {
        $(this).attr('class', 'temporary')
        return old
      })
    },
    { change: false }
  )

  check('listener registration validates synchronously without an initial batch', () => {
    const $ = load(),
      seen = []
    subscribe($, (rows) => seen.push(rows))
    assert.deepEqual(seen, [])
    for (const invalid of [undefined, null, {}, [], 3, 'listener'])
      assert.throws(() => $.observeChanges(invalid), { name: 'TypeError' })
    $('#a').attr('title', 'valid')
    assert.equal(seen.length, 1)
  })
  check('duplicate registrations unsubscribe independently and idempotently', () => {
    const $ = load()
    let calls = 0
    const listener = () => calls++
    const first = subscribe($, listener),
      second = subscribe($, listener)
    $('#a').attr('title', 'one')
    assert.equal(calls, 2)
    first()
    first()
    $('#a').attr('title', 'two')
    assert.equal(calls, 3)
    second()
    $('#a').attr('title', 'three')
    assert.equal(calls, 3)
  })
  check('mutations on two documents have separate listeners', () => {
    const a = load(),
      b = load(),
      aa = [],
      bb = []
    subscribe(a, (r) => aa.push(r))
    subscribe(b, (r) => bb.push(r))
    a('#a').attr('title', 'left')
    assert.equal(aa.length, 1)
    assert.equal(bb.length, 0)
    b('#a').attr('title', 'right')
    assert.equal(aa.length, 1)
    assert.equal(bb.length, 1)
    assert.equal(aa[0][0].target, a('#a')[0])
    assert.equal(bb[0][0].target, b('#a')[0])
  })
  check('cross-document move reports source and destination ownership', () => {
    const a = load(),
      b = load(),
      aa = [],
      bb = [],
      moving = a('#outside')[0]
    const beforeA = snapshot(a),
      beforeB = snapshot(b)
    subscribe(a, (r) => aa.push(r))
    subscribe(b, (r) => bb.push(r))
    b('#b').append(moving)
    assert.equal(aa.length, 1)
    assert.equal(bb.length, 1)
    compareRecords(aa[0], expectedChanges(beforeA, snapshot(a)))
    compareRecords(bb[0], expectedChanges(beforeB, snapshot(b)))
    aa.length = 0
    bb.length = 0
    a(moving).attr('title', 'now-right')
    assert.equal(aa.length, 0)
    assert.equal(bb.length, 1)
    assert.equal(bb[0][0].target, moving)
  })
  check('detached edits are quiet and reattachment follows current owner', () => {
    const $ = load(),
      batches = [],
      node = $('#a')
    subscribe($, (r) => batches.push(r))
    node.remove()
    assert.equal(batches.length, 1)
    batches.length = 0
    node.attr('title', 'detached').append('<b>x</b>')
    assert.equal(batches.length, 0)
    $('main').append(node)
    assert.equal(batches.length, 1)
    batches.length = 0
    node.attr('title', 'attached')
    assert.equal(batches.length, 1)
  })
  check('a mixed-document selection notifies both owners', () => {
    const a = load(),
      b = load(),
      aa = [],
      bb = []
    subscribe(a, (r) => aa.push(r))
    subscribe(b, (r) => bb.push(r))
    a([a('#a')[0], b('#a')[0]]).attr('title', 'mixed')
    assert.equal(aa.length, 1)
    assert.equal(bb.length, 1)
    assert.equal(aa[0][0].target, a('#a')[0])
    assert.equal(bb[0][0].target, b('#a')[0])
  })
  check('batches contain stable snapshots and listener-local metadata', () => {
    const $ = load(),
      observed = []
    subscribe($, (rows) => {
      for (const r of rows) {
        if (r.type === 'children') r.newChildren.length = 0
        else r.newValue = 'corrupted'
      }
      rows.length = 0
    })
    subscribe($, (rows) => observed.push(rows))
    const before = snapshot($)
    $('#a').append('<b>x</b>')
    const expected = expectedChanges(before, snapshot($))
    compareRecords(observed[0], expected)
    const firstSnapshot = [...observed[0][0].newChildren]
    $('#a').append('<b>later</b>')
    assert.deepEqual(observed[0][0].newChildren, firstSnapshot)
    $('#a').attr('title', 'clean')
    assert.equal(observed.at(-1)[0].newValue, 'clean')
  })
  check('subscription changes during delivery affect later batches', () => {
    const $ = load(),
      calls = []
    let stopSecond
    subscribe($, () => {
      calls.push('first')
      stopSecond()
      subscribe($, () => calls.push('new'))
    })
    stopSecond = subscribe($, () => calls.push('second'))
    $('#a').attr('title', 'one')
    assert.deepEqual(calls, ['first', 'second'])
    calls.length = 0
    $('#a').attr('title', 'two')
    assert.deepEqual(calls, ['first', 'new'])
  })
  check('listener reentrancy is queued after the current listener batch', () => {
    const $ = load(),
      order = []
    let entered = false
    subscribe($, (r) => {
      order.push(`first:${r[0].newValue}`)
      if (!entered) {
        entered = true
        $('#a').attr('title', 'nested')
      }
    })
    subscribe($, (r) => order.push(`second:${r[0].newValue}`))
    $('#a').attr('title', 'outer')
    assert.deepEqual(order, ['first:outer', 'second:outer', 'first:nested', 'second:nested'])
  })
  check('reentrant edits on another document retain its subscriptions', () => {
    const a = load(),
      b = load(),
      order = []
    subscribe(a, () => {
      order.push('a-first')
      b('#a').attr('title', 'from-a')
    })
    subscribe(a, () => order.push('a-second'))
    subscribe(b, (r) => {
      order.push('b')
      assert.equal(r[0].target, b('#a')[0])
    })
    a('#a').attr('title', 'outer')
    assert.deepEqual(order, ['a-first', 'a-second', 'b'])
  })
  check('partial setter failure notifies committed changes and preserves error identity', () => {
    const $ = load(),
      batches = [],
      error = new Error('setter failed'),
      before = snapshot($)
    subscribe($, (r) => batches.push(r))
    assert.throws(
      () =>
        $('section').attr('title', (i) => {
          if (i === 1) throw error
          return 'first'
        }),
      (caught) => caught === error
    )
    assert.equal(batches.length, 1)
    compareRecords(batches[0], expectedChanges(before, snapshot($)))
    $('#a').attr('title', 'recovered')
    assert.equal(batches.length, 2)
  })
  check('listener failures preserve changes, continue delivery and restore later dispatch', () => {
    const $ = load(),
      error = new Error('listener failed'),
      seen = []
    let first = true
    subscribe($, () => {
      if (first) {
        first = false
        throw error
      }
    })
    subscribe($, (r) => seen.push(r))
    assert.throws(
      () => $('#a').attr('title', 'committed'),
      (caught) => caught === error
    )
    assert.equal($('#a').attr('title'), 'committed')
    assert.equal(seen.length, 1)
    $('#a').attr('title', 'next')
    assert.equal(seen.length, 2)
  })
  check('mutator exception wins while queued notifications still drain', () => {
    const $ = load(),
      setter = new Error('setter'),
      listener = new Error('listener'),
      seen = []
    let nested = false
    subscribe($, () => {
      if (!nested) {
        nested = true
        $('#input').attr('title', 'queued')
        throw listener
      }
    })
    subscribe($, (r) => seen.push(r))
    assert.throws(
      () =>
        $('section').attr('title', (i) => {
          if (i) throw setter
          return 'committed'
        }),
      (caught) => caught === setter
    )
    assert.equal(seen.length, 2)
    assert.equal($('#input').attr('title'), 'queued')
    $('#a').attr('title', 'works')
    assert.equal(seen.length, 3)
  })
  check('falsy thrown values retain identity across mutation and listener failures', () => {
    for (const value of [undefined, null, false, 0, '']) {
      for (const source of ['mutator', 'listener']) {
        const $ = load()
        let caught = false,
          seen = 0
        if (source === 'listener')
          subscribe($, () => {
            throw value
          })
        subscribe($, () => seen++)
        try {
          if (source === 'mutator')
            $('section').attr('title', (i) => {
              if (i) throw value
              return 'first'
            })
          else $('#a').attr('title', 'first')
        } catch (error) {
          caught = true
          assert.equal(error, value)
        }
        assert.equal(caught, true)
        assert.equal(seen, 1)
      }
    }
  })
}
