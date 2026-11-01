const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const M=require('../src/manifest.cjs'),root=path.resolve(__dirname,'..'),base=path.join(root,'fixtures/runs');fs.mkdirSync(base,{recursive:true});
function work(fn){const p=fs.mkdtempSync(path.join(base,'case-'));fs.writeFileSync(path.join(p,'source.txt'),'source');fs.writeFileSync(path.join(p,'output.txt'),'result');try{return fn(p)}finally{fs.rmSync(p,{recursive:true,force:true});}}
test('capture verifies exact source/artifact hashes without absolute paths',()=>work(p=>{const m=M.capture(p,'scratch',['source.txt'],['output.txt']);assert.equal(m.mode,'snapshot-only');assert.equal(m.state,'not-executed');assert.equal(JSON.stringify(m).includes(p),false);assert.equal(M.verifyFiles(m,p).matches,true);}));
test('source and output changes are distinct and no causality is inferred',()=>work(p=>{const a=M.capture(p,'scratch',['source.txt'],['output.txt']);fs.writeFileSync(path.join(p,'source.txt'),'new');const b=M.capture(p,'scratch',['source.txt'],['output.txt']);assert.deepEqual(M.compare(a,b).differences.map(x=>x.kind),['sources']);assert.equal(M.verifyFiles(a,p).matches,false);}));
test('different project namespaces refuse comparison',()=>work(p=>{assert.throws(()=>M.compare(M.capture(p,'a',['source.txt'],[]),M.capture(p,'b',['source.txt'],[])),/namespace/);}));
test('tampered bytes and malformed digests reject',()=>work(p=>{const m=M.capture(p,'x',['source.txt'],[]);m.sources[0].sha256='0'.repeat(64);assert.throws(()=>M.validate(m),/digest/);assert.throws(()=>M.parse('{}'));}));
test('unknown cloud/interrupted state remains explicit',()=>work(p=>{const m=M.capture(p,'x',[],[],{mode:'unobserved-cloud',state:'interrupted',events:[{kind:'interruption-reported',id:'event1'}]});assert.equal(M.parse(JSON.stringify(m)).state,'interrupted');assert.match(m.unknowns[0],/do not prove/);}));
test('unsafe paths and case-ambiguous identities reject',()=>work(p=>{for(const f of ['../outside','/root','C:/outside','a\\b','a/../b'])assert.throws(()=>M.snapshotFiles(p,[f]));assert.throws(()=>M.capture(p,'x',['source.txt','source.txt'],[]),/ambiguous/);}));
test('oversized manifests and resource counts reject',()=>{assert.throws(()=>M.parse('x'.repeat(5_000_001)));assert.throws(()=>M.canonical(Infinity));assert.throws(()=>M.seal({schema:'task-lineage/v1',project:'x',mode:'snapshot-only',state:'not-executed',sources:[],artifacts:[],events:Array.from({length:2001},()=>({kind:'x',id:'x'}))}));});
test('missing artifact is unavailable, not silently unchanged',()=>work(p=>{const m=M.capture(p,'x',[],['output.txt']);fs.unlinkSync(path.join(p,'output.txt'));assert.equal(M.verifyFiles(m,p).findings[0].state,'unavailable');}));
test('actual CLI fresh-process snapshot and verify run',()=>work(p=>{const cli=path.join(root,'src/cli.cjs');const run=args=>cp.spawnSync(process.execPath,[cli,...args],{cwd:p,encoding:'utf8'});assert.equal(run(['snapshot','scratch','source.txt','output.txt','revision.json']).status,0);assert.equal(run(['verify','revision.json']).status,0);fs.writeFileSync(path.join(p,'output.txt'),'changed');assert.equal(run(['verify','revision.json']).status,2);}));
test('canonical ordering is stable and inherited/prototype values are not accepted',()=>{assert.equal(M.canonical({b:1,a:2}),M.canonical({a:2,b:1}));assert.throws(()=>M.canonical(JSON.parse('{"__proto__":1}')),/Unsafe/);});
test('strict JSON rejects duplicate escaped keys and lossy numbers',()=>{const J=require('../src/strict-json.cjs');for(const x of ['{"a":1,"\\u0061":2}','{"x":-0}','{"x":1e999}','{"x":9007199254740993}','{"x":"\\ud800"}','{"a":1,}','true false'])assert.throws(()=>J.parse(x));assert.equal(J.parse('{"equation":"x²","x":1.5}').equation,'x²');});
test('a rewritten manifest cannot match an independently retained digest',()=>work(p=>{const a=M.capture(p,'x',['source.txt'],[]);const changed=M.seal({...a,state:'completed'});assert.throws(()=>M.parse(JSON.stringify(changed),a.digest),/anchor/);assert.equal(M.parse(JSON.stringify(a),a.digest).digest,a.digest);}));
test('duplicate event IDs and oversized real files reject',()=>work(p=>{assert.throws(()=>M.capture(p,'x',[],[],{events:[{kind:'a',id:'1'},{kind:'b',id:'1'}]}),/duplicate/);fs.writeFileSync(path.join(p,'large.bin'),Buffer.alloc(8_000_001));assert.throws(()=>M.snapshotFiles(p,['large.bin']),/budget/);}));
test('actual CLI refuses a linked output parent',()=>work(p=>{const outside=fs.mkdtempSync(path.join(base,'outside-'));try{fs.symlinkSync(outside,path.join(p,'linked'),process.platform==='win32'?'junction':'dir');const r=cp.spawnSync(process.execPath,[path.join(root,'src/cli.cjs'),'snapshot','x','source.txt','','linked/new.json'],{cwd:p,encoding:'utf8'});assert.notEqual(r.status,0);assert.equal(fs.existsSync(path.join(outside,'new.json')),false);}finally{fs.rmSync(path.join(p,'linked'),{force:true,recursive:true});fs.rmSync(outside,{recursive:true,force:true});}}));

test('comparison exposes byte-length changes even when declared SHA is identical',()=>{
 const body={schema:'task-lineage/v1',project:'sizes',mode:'snapshot-only',state:'not-executed',sources:[{path:'same.txt',bytes:1,sha256:'a'.repeat(64)}],artifacts:[],events:[]};
 const a=M.seal(body),b=M.seal({...body,sources:[{...body.sources[0],bytes:2}]});
 const diff=M.compare(a,b).differences;assert.equal(diff.length,1);assert.equal(diff[0].change,'changed');assert.equal(diff[0].before,diff[0].after);assert.equal(diff[0].beforeBytes,1);assert.equal(diff[0].afterBytes,2);
});
test('each imported role enforces100 files and32MB with exact boundaries accepted',()=>{
 const files=(n,bytes)=>Array.from({length:n},(_,i)=>({path:'file-'+i,bytes,sha256:'a'.repeat(64)}));
 const body={schema:'task-lineage/v1',project:'budgets',mode:'snapshot-only',state:'not-executed',sources:[],artifacts:[],events:[]};
 const sealRaw=value=>({...value,digest:M.hash(M.canonical(value))});
 assert.equal(M.parse(JSON.stringify(sealRaw({...body,sources:files(100,0),artifacts:files(100,0)}))).sources.length,100);
 assert.equal(M.parse(JSON.stringify(sealRaw({...body,sources:files(4,8_000_000),artifacts:files(4,8_000_000)}))).artifacts.length,4);
 for(const role of ['sources','artifacts']){
  assert.throws(()=>M.parse(JSON.stringify(sealRaw({...body,[role]:files(101,0)}))),/list count limit/);
  assert.throws(()=>M.parse(JSON.stringify(sealRaw({...body,[role]:files(5,8_000_000)}))),/list byte budget/);
 }
});
test('verification bounds actual reads across changed files and resets budget per role',()=>work(p=>{
 const contents=Buffer.alloc(8_000_000,7);fs.writeFileSync(path.join(p,'blob.bin'),contents);
 const files=Array.from({length:6},(_,i)=>{const name='copy-'+i+'.bin';fs.linkSync(path.join(p,'blob.bin'),path.join(p,name));return {path:name,bytes:1,sha256:M.hash('x')};});
 const m=M.seal({schema:'task-lineage/v1',project:'actual-budget',mode:'snapshot-only',state:'not-executed',sources:files,artifacts:[{path:'blob.bin',bytes:contents.length,sha256:M.hash(contents)}],events:[]});
 const original=fs.readSync;let bytesRead=0;let result;
 fs.readSync=function(...args){const count=original(...args);bytesRead+=count;return count;};
 try{result=M.verifyFiles(m,p);}finally{fs.readSync=original;}
 assert.equal(bytesRead,40_000_000);assert.equal(result.matches,false);assert.equal(result.findings.filter(f=>f.kind==='artifacts').length,0);
 assert.deepEqual(result.findings.filter(f=>f.state==='unavailable').map(f=>f.path),['copy-4.bin','copy-5.bin']);
 assert.ok(result.findings.filter(f=>f.state==='unavailable').every(f=>/list read budget/.test(f.reason)));
}));
test('oversized manifest descriptor is refused before buffer allocation or file reads',()=>work(p=>{
 const file=path.join(p,'oversized.json');fs.writeFileSync(file,Buffer.alloc(5_000_001,32));
 const originalRead=fs.readSync,originalAlloc=Buffer.alloc;let reads=0,allocations=0;
 fs.readSync=function(...args){reads++;return originalRead(...args);};Buffer.alloc=function(...args){allocations++;return originalAlloc(...args);};
 try{assert.throws(()=>M.readManifestFile(file),/Manifest file exceeds5MB/);}finally{fs.readSync=originalRead;Buffer.alloc=originalAlloc;}
 assert.equal(reads,0);assert.equal(allocations,0);
}));
test('bounded manifest reader accepts exactly5MB and checks an independent anchor',()=>work(p=>{
 const m=M.capture(p,'reader',['source.txt'],[]),json=JSON.stringify(m),file=path.join(p,'boundary.json');
 fs.writeFileSync(file,json+' '.repeat(5_000_000-Buffer.byteLength(json)));
 assert.equal(M.readManifestFile(file,m.digest).digest,m.digest);
 assert.throws(()=>M.readManifestFile(file,'0'.repeat(64)),/anchor/);
}));
test('actual verify and both compare inputs use the bounded manifest reader',()=>work(p=>{
 const cli=path.join(root,'src/cli.cjs'),valid=path.join(p,'valid.json'),large=path.join(p,'large.json');
 fs.writeFileSync(valid,JSON.stringify(M.capture(p,'cli-budget',[],[])));fs.writeFileSync(large,Buffer.alloc(5_000_001,32));
 for(const args of [['verify',large],['compare',valid,large],['compare',large,valid]]){
  const result=cp.spawnSync(process.execPath,[cli,...args],{cwd:p,encoding:'utf8'});assert.equal(result.status,1);assert.match(result.stderr,/Manifest file exceeds5MB/);
 }
}));
