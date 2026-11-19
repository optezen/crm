import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const templates=JSON.parse(readFileSync(new URL('../config/industries.json', import.meta.url),'utf8'));
test('three distinct industry templates exist',()=>assert.deepEqual(Object.keys(templates).sort(),['clinic','salon','scrap']));
for(const [key,item] of Object.entries(templates)) {
 test(`${key}: modules and pipeline configured`,()=>{assert.ok(item.modules.length>=6);assert.ok(item.pipeline.length>=3);assert.equal(new Set(item.modules).size,item.modules.length);assert.equal(new Set(item.pipeline).size,item.pipeline.length);});
 test(`${key}: records have custom field definitions`,()=>{assert.ok(item.records.length);for(const record of item.records)assert.ok(record.fields.length>1)});
}
