import test from 'node:test'; import assert from 'node:assert/strict';
import { parseCsv, leadsFromCsv } from '../src/lib/crm/csv.ts';
test('csv: quotes, commas, newlines, BOM, CRLF', () => {
  assert.deepEqual(parseCsv('﻿a,b\r\n"x, y","he said ""hi""\nthere"\r\n\r\n'), [['a', 'b'], ['x, y', 'he said "hi"\nthere']]);
});
test('leads: header aliases, source normalised, blanks dropped, errors explained', () => {
  const r = leadsFromCsv('Full Name,Mobile,E-mail,Source,Junk\nAsha,+919800000001,,Meta Ads,z\nBen,,b@x.com,TikTok,');
  assert.ok(r.ok); assert.deepEqual(r.rows[0], { line: 2, data: { fullName: 'Asha', phone: '+919800000001', source: 'meta_ads' } });
  assert.deepEqual(r.rows[1].data, { fullName: 'Ben', email: 'b@x.com', source: 'other' });
  assert.equal(leadsFromCsv('Phone\n1').ok, false); assert.equal(leadsFromCsv('Name').ok, false);
});
