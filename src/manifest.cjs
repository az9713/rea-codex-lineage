'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const LIMITS=Object.freeze({manifestBytes:5_000_000,filesPerList:100,bytesPerList:32_000_000,fileBytes:8_000_000});
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
function canonical(v,depth=0){if(depth>24)throw Error('Manifest nesting limit');if(v===null||typeof v==='string'||typeof v==='boolean')return JSON.stringify(v);if(typeof v==='number'&&Number.isFinite(v))return JSON.stringify(v);if(Array.isArray(v))return '['+v.map(x=>canonical(x,depth+1)).join(',')+']';if(v&&typeof v==='object')return '{'+Object.keys(v).sort().map(k=>{if(['__proto__','prototype','constructor'].includes(k))throw Error('Unsafe object key');return JSON.stringify(k)+':'+canonical(v[k],depth+1)}).join(',')+'}';throw Error('Unsupported manifest value');}
function safePath(p){return typeof p==='string'&&p.length>0&&p.length<1024&&!p.includes('\\')&&!p.startsWith('/')&&!/^[A-Za-z]:/.test(p)&&!p.split('/').some(x=>!x||x==='..'||x==='.')&&!/[\x00-\x1f]/.test(p);}
function validate(m){
 if(!m||m.schema!=='task-lineage/v1'||typeof m.project!=='string'||!m.project||m.project.length>200||!['snapshot-only','controlled-rerun','app-server-observed','unobserved-cloud'].includes(m.mode)||!['completed','interrupted','failed','not-executed'].includes(m.state)||!Array.isArray(m.sources)||!Array.isArray(m.artifacts)||!Array.isArray(m.events))throw Error('Unsupported lineage manifest');
 if(m.sources.length+m.artifacts.length>200||m.events.length>2000)throw Error('Manifest count limit');
 for(const list of [m.sources,m.artifacts]){
  if(list.length>LIMITS.filesPerList)throw Error('File list count limit');
  const seen=new Set();let declaredBytes=0;
  for(const f of list){if(!f||!safePath(f.path)||seen.has(f.path.toLowerCase())||!Number.isSafeInteger(f.bytes)||f.bytes<0||f.bytes>LIMITS.fileBytes||typeof f.sha256!=='string'||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid or ambiguous file identity');seen.add(f.path.toLowerCase());declaredBytes+=f.bytes;}
  if(declaredBytes>LIMITS.bytesPerList)throw Error('File list byte budget exceeded');
 }
 const eventIds=new Set();for(const e of m.events){if(!e||typeof e.kind!=='string'||!e.kind||e.kind.length>100||typeof e.id!=='string'||!e.id||e.id.length>200||eventIds.has(e.id))throw Error('Invalid or duplicate event envelope');eventIds.add(e.id);}
 if(typeof m.digest!=='string'||!/^[a-f0-9]{64}$/.test(m.digest))throw Error('Missing manifest digest');
 const {digest,...body}=m;if(hash(canonical(body))!==digest)throw Error('Manifest digest mismatch');return m;
}
function parse(text,expectedDigest){const m=validate(require('./strict-json.cjs').parse(text));if(expectedDigest!==undefined&&expectedDigest!==m.digest)throw Error('Independent manifest anchor mismatch');return m;}
function readManifestFile(file,expectedDigest){
 const fd=fs.openSync(file,'r');
 try{
  const info=fs.fstatSync(fd);
  if(!info.isFile())throw Error('Manifest input must be a regular file');
  if(info.size>LIMITS.manifestBytes)throw Error('Manifest file exceeds5MB');
  // Allocate from the checked descriptor size; one extra byte detects growth.
  const bytes=Buffer.alloc(info.size+1);let offset=0;
  while(offset<bytes.length){const got=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!got)break;offset+=got;}
  const after=fs.fstatSync(fd);
  if(offset!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw Error('Manifest changed during read');
  return parse(bytes.subarray(0,offset).toString('utf8'),expectedDigest);
 }finally{fs.closeSync(fd);}
}
function seal(body){const {digest:old,...clean}=body;const m={...clean,digest:hash(canonical(clean))};return validate(m);}
function snapshotWithBudget(root,paths,budget){
 if(budget.exhausted)throw Error('File list read budget exceeded');
 const real=fs.realpathSync(root);if(!Array.isArray(paths)||paths.length>LIMITS.filesPerList)throw Error('Snapshot file limit');
 return paths.map(p=>{if(!safePath(p))throw Error('Unsafe relative file path');const file=path.resolve(real,p);if(!file.startsWith(real+path.sep)||!fs.realpathSync(file).startsWith(real+path.sep)||fs.lstatSync(file).isSymbolicLink())throw Error('Linked or outside file refused');let parent=path.dirname(file);while(parent!==real){if(fs.lstatSync(parent).isSymbolicLink())throw Error('Linked ancestor refused');parent=path.dirname(parent);}
 const fd=fs.openSync(file,'r');try{
  const info=fs.fstatSync(fd);if(!info.isFile()||info.size>LIMITS.fileBytes)throw Error('File read budget exceeded');
  if(budget.bytes+info.size>LIMITS.bytesPerList){budget.exhausted=true;throw Error('File list read budget exceeded');}
  const capacity=Math.min(info.size+1,LIMITS.bytesPerList-budget.bytes);budget.bytes+=info.size;
  const bytes=Buffer.alloc(capacity);let offset=0;while(offset<bytes.length){const got=fs.readSync(fd,bytes,offset,bytes.length-offset,null);if(!got)break;offset+=got;}budget.bytes+=Math.max(0,offset-info.size);const after=fs.fstatSync(fd);if(offset!==info.size||after.size!==info.size||after.mtimeMs!==info.mtimeMs)throw Error('File changed during snapshot');return {path:p,bytes:offset,sha256:hash(bytes.subarray(0,offset))};
 }finally{fs.closeSync(fd);}});
}
function snapshotFiles(root,paths){return snapshotWithBudget(root,paths,{bytes:0,exhausted:false});}
function capture(root,project,sources,artifacts,options={}){return seal({schema:'task-lineage/v1',project,mode:options.mode||'snapshot-only',state:options.state||'not-executed',sources:snapshotFiles(root,sources),artifacts:snapshotFiles(root,artifacts),events:options.events||[],unknowns:['Declared input/output relationships do not prove model use or causality.','Remote operations and environment factors not explicitly captured remain unknown.']});}
function compare(a,b){validate(a);validate(b);if(a.project!==b.project)throw Error('Project namespace differs');const differences=[];for(const kind of ['sources','artifacts']){const left=new Map(a[kind].map(f=>[f.path,f])),right=new Map(b[kind].map(f=>[f.path,f]));for(const p of [...new Set([...left.keys(),...right.keys()])].sort()){const x=left.get(p),y=right.get(p);if(!x||!y||x.sha256!==y.sha256||x.bytes!==y.bytes)differences.push({kind,path:p,change:!x?'added':!y?'missing':'changed',before:x?.sha256||null,after:y?.sha256||null,beforeBytes:x?.bytes??null,afterBytes:y?.bytes??null});}}return {differences,modes:[a.mode,b.mode],states:[a.state,b.state],eventCounts:[a.events.length,b.events.length],scope:'Snapshot differences and observed event counts, not inferred causal attribution.'};}
function verifyFiles(m,root){
 validate(m);const findings=[];
 for(const kind of ['sources','artifacts']){
  // Actual descriptor sizes share one budget per role, not one per file. A
  // small declared size cannot authorize unbounded reads of changed files.
  const budget={bytes:0,exhausted:false};
  for(const expected of m[kind]){try{const now=snapshotWithBudget(root,[expected.path],budget)[0];if(now.sha256!==expected.sha256||now.bytes!==expected.bytes)findings.push({kind,path:expected.path,state:'changed'});}catch(e){findings.push({kind,path:expected.path,state:'unavailable',reason:e.message});}}
 }
 return {matches:findings.length===0,findings};
}
module.exports={LIMITS,canonical,hash,safePath,validate,parse,readManifestFile,seal,snapshotFiles,capture,compare,verifyFiles};
