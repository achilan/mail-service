import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { CATALOG } from '../src/templates/catalog.js';
import { htmlToText } from '../src/mail/text.js';
import { startTestServer } from './helpers.js';

describe('plantillas incluidas', () => {
  let t;
  before(async () => { t = await startTestServer(); });
  after(() => t.close());

  for (const name of Object.keys(CATALOG.email)) {
    test(`${name}: renderiza con sampleData, sin variables sin resolver`, () => {
      const { sampleData } = t.store.view('email', name);
      const out = t.engine.render(name, sampleData);
      assert.ok(out.subject.length > 0);
      assert.match(out.html, /^<!doctype html>/i);
      assert.doesNotMatch(out.html, /\{\{|\}\}/);
      assert.match(out.html, /role="presentation"/);
      assert.match(out.html, /prefers-color-scheme: dark/);
      assert.ok(out.text.length > 50);
    });

    test(`${name}: no falla con contexto vacío`, () => {
      assert.doesNotThrow(() => t.engine.render(name, {}));
    });
  }

  test('formatMoney y formatDate', () => {
    const out = t.engine.renderDefinition({ kind: 'email', layout: 'none', html: '{{formatMoney 1234.5}}|{{formatMoney 10 "EUR"}}|{{formatDate "2026-06-06T15:00:00Z"}}' });
    assert.match(out.html, /1\.?234,50/);
    assert.match(out.html, /EUR|€/);
    assert.match(out.html, /junio de 2026/);
  });

  test('htmlToText', () => {
    assert.equal(htmlToText('<p>Hola <a href="https://x.com">aquí</a></p><ul><li>uno</li></ul>'), 'Hola aquí (https://x.com)\n• uno');
  });
});
