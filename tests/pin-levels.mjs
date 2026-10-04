import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { build } from 'esbuild';
await build({entryPoints:['worker/index.ts'],bundle:true,format:'esm',platform:'browser',outfile:'/tmp/mykeep-pin-worker.mjs'});
const {default:worker}=await import('/tmp/mykeep-pin-worker.mjs');
const sqlite=new DatabaseSync(':memory:');
const migrations=readdirSync('migrations').filter(f=>f.endsWith('.sql')).sort();
for(const name of migrations.filter(n=>n<'0007')) sqlite.exec(readFileSync('migrations/'+name,'utf8'));
const legacy='11111111-1111-4111-8111-111111111111';
sqlite.prepare("INSERT INTO notes(id,title,pinned,created_at,updated_at) VALUES(?,?,1,?,?)").run(legacy,'legacy pin','2026-01-01','2026-01-01');
sqlite.exec(readFileSync('migrations/0007_pin_levels.sql','utf8'));
sqlite.exec(readFileSync('migrations/0008_pin_headings.sql','utf8'));
sqlite.exec(readFileSync('migrations/0009_card_order.sql','utf8'));
class Statement {
 constructor(sql,args=[]){this.sql=sql;this.args=args;}
 bind(...args){return new Statement(this.sql,args);}
 async first(){return sqlite.prepare(this.sql).get(...this.args)??null;}
 async all(){return {results:sqlite.prepare(this.sql).all(...this.args),success:true};}
 async run(){return {meta:sqlite.prepare(this.sql).run(...this.args),success:true};}
}
const env={DB:{prepare:sql=>new Statement(sql),batch:async statements=>Promise.all(statements.map(s=>/^\s*SELECT\b|RETURNING/i.test(s.sql)?s.all():s.run()))}};
async function call(path,method='GET',body){const response=await worker.fetch(new Request('https://mykeep.example'+path,{method,headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)}),env);return {status:response.status,data:await response.json()};}
let r=await call('/api/notes/'+legacy);assert.equal(r.data.note.pin_level,1);
const ids=[];
for(const level of [3,0,2,1]){r=await call('/api/notes','POST',{title:'level '+level,pin_level:level});assert.equal(r.status,201);assert.equal(r.data.note.pinned,level>0);assert.equal(r.data.note.pin_level,level);ids.push(r.data.note.id);}
r=await call('/api/notes');assert.deepEqual(r.data.notes.map(n=>n.pin_level),[1,1,2,3,0]);
r=await call('/api/notes/'+ids[2],'PATCH',{body:'edited'});assert.equal(r.data.note.pin_level,2);
r=await call('/api/notes/'+ids[2],'PATCH',{pin_level:3});assert.equal(r.data.note.pin_level,3);
r=await call('/api/notes/'+ids[2],'PATCH',{pinned:false});assert.equal(r.data.note.pin_level,0);
r=await call('/api/notes/'+ids[2],'PATCH',{pinned:true});assert.equal(r.data.note.pin_level,1);
for(const level of [-1,4,1.5,'2',null]){r=await call('/api/notes','POST',{title:'bad',pin_level:level});assert.equal(r.status,400);}
r=await call('/api/notes','POST',{title:'bad',pin_level:2,pinned:false});assert.equal(r.status,400);
r=await call('/api/notes?view=unpinned');assert(r.data.notes.every(n=>!n.pinned&&n.pin_level===0));
// Old code can still read and update the unchanged boolean column after migration.
assert.equal(sqlite.prepare('SELECT pinned FROM notes WHERE id=?').get(legacy).pinned,1);
sqlite.prepare('UPDATE notes SET pinned=0 WHERE id=?').run(legacy);
r=await call('/api/notes/'+legacy);assert.equal(r.data.note.pin_level,0);
console.log('PASS: legacy migration, create/move/unpin, edit preservation, ordering, validation, unpinned view, rollback compatibility');

r=await call('/api/pin-headings');assert.deepEqual(r.data.headings,['1段目','2段目','3段目']);
for(const level of [1,2,3]){r=await call('/api/pin-headings','PATCH',{level,title:'  見出し'+level+'  '});assert.equal(r.status,200);assert.equal(r.data.headings[level-1],'見出し'+level);}
r=await call('/api/pin-headings');assert.deepEqual(r.data.headings,['見出し1','見出し2','見出し3']);
for(const input of [{level:0,title:'bad'},{level:4,title:'bad'},{level:1,title:' '},{level:2,title:'x'.repeat(61)},null]) {r=await call('/api/pin-headings','PATCH',input);assert.equal(r.status,400);}
console.log('PASS: headings defaults, three independent edits, trimming, persistence and validation');

const moveIds=[];
for(let i=0;i<3;i++){r=await call('/api/notes','POST',{title:'drag '+i,pin_level:2});moveIds.push(r.data.note.id);}
r=await call('/api/notes/move','POST',{id:moveIds[2],level:2,before_id:moveIds[0]});assert.equal(r.status,200);
r=await call('/api/notes');assert(r.data.notes.findIndex(n=>n.id===moveIds[2])<r.data.notes.findIndex(n=>n.id===moveIds[0]));
r=await call('/api/notes/move','POST',{id:moveIds[2],level:3,before_id:null});assert.equal(r.status,200);
r=await call('/api/notes/'+moveIds[2]);assert.equal(r.data.note.pin_level,3);
r=await call('/api/notes/move','POST',{id:moveIds[2],level:0,before_id:null});assert.equal(r.status,200);
r=await call('/api/notes/'+moveIds[2]);assert.equal(r.data.note.pinned,false);
r=await call('/api/notes/move','POST',{id:moveIds[0],level:2,before_id:moveIds[2]});assert.equal(r.status,409);
r=await call('/api/notes/move','POST',{id:moveIds[0],level:9,before_id:null});assert.equal(r.status,400);
r=await call('/api/notes/'+moveIds[0],'PATCH',{body:'edit keeps position'});const position=r.data.note.sort_order;
r=await call('/api/notes/'+moveIds[0]);assert.equal(r.data.note.sort_order,position);
console.log('PASS: reorder, cross-group move, unpin, invalid destination, persistence');

const imageNote=await call('/api/notes','POST',{title:'image-filter',url:'https://example.com/',preview_image:'https://example.com/test.png'});
r=await call('/api/notes?view=images');assert(r.data.notes.some(n=>n.id===imageNote.data.note.id));
r=await call('/api/notes?view=imageless');assert(!r.data.notes.some(n=>n.id===imageNote.data.note.id));
r=await call('/api/counts');assert.equal(typeof r.data.views.images,'number');
await call('/api/notes/'+imageNote.data.note.id,'PATCH',{archived:true});
r=await call('/api/notes?view=images');assert(!r.data.notes.some(n=>n.id===imageNote.data.note.id));
console.log('PASS: image filter, inverse filter, count and archive exclusion');

// Exercise the attachment API with a real database and an in-memory R2 bucket.
const objects = new Map();
env.IMAGES = {
  async put(key, bytes) { objects.set(key, new Uint8Array(bytes)); },
  async get(key) { const body = objects.get(key); return body ? { body, size: body.length, httpEtag: '"test"' } : null; },
  async delete(key) { objects.delete(key); },
};
const attachmentNote = (await call('/api/notes', 'POST', { title: 'attachments' })).data.note.id;
for (const [filename, mime, content] of [['資料.pdf','application/pdf','%PDF-test'], ['data.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','sheet'], ['unknown.bin','application/octet-stream','binary'], ['page.html','text/html','<script>alert(1)</script>'], ['image.png','image/png','png']]) {
  const response = await worker.fetch(new Request(`https://mykeep.example/api/notes/${attachmentNote}/attachments`, { method: 'POST', headers: { 'Content-Type': mime, 'X-File-Name': encodeURIComponent(filename) }, body: content }), env);
  assert.equal(response.status, 201);
  const { attachment } = await response.json();
  assert.equal(attachment.filename, filename);
  assert.equal(attachment.mime_type, mime);
  const download = await worker.fetch(new Request('https://mykeep.example' + attachment.url), env);
  assert.equal(await download.text(), content);
  assert.equal(download.headers.get('X-Content-Type-Options'), 'nosniff');
  if (mime === 'image/png') assert.equal(download.headers.get('Content-Type'), mime);
  else { assert.equal(download.headers.get('Content-Type'), 'application/octet-stream'); assert(download.headers.get('Content-Disposition').includes(encodeURIComponent(filename))); }
  assert.equal((await call(`/api/notes/${attachmentNote}/attachments/${attachment.id}`, 'DELETE')).status, 200);
  assert.equal(objects.size, 0);
}
const oversize = await worker.fetch(new Request(`https://mykeep.example/api/notes/${attachmentNote}/attachments`, { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-File-Name': 'large.pdf', 'Content-Length': String(21*1024*1024) }, body: 'test' }), env);
assert.equal(oversize.status, 413);
await build({entryPoints:['src/fileAppearance.ts'],bundle:true,format:'esm',platform:'browser',outfile:'/tmp/mykeep-file-appearance.mjs'});
const {fileAppearance} = await import('/tmp/mykeep-file-appearance.mjs');
for (const [filename, label] of [['report.PDF','PDF'], ['sheet.xlsx','表計算'], ['doc.docx','文書'], ['slides.pptx','プレゼンテーション'], ['sound.mp3','音声'], ['movie.mp4','動画'], ['archive.zip','圧縮ファイル'], ['data.bin','ファイル']]) assert.equal(fileAppearance(filename, '').label, label);
assert.equal(fileAppearance('record', 'audio/ogg').label, '音声');
console.log('PASS: file upload/download/delete, Unicode filenames, image compatibility, safe downloads, size limit and file icons');
