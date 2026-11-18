import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {chmodSync,existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,unlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {acquireCompositionLease,addLocalRetentionPin,applyClaimedPackageObjectDeletion,applyLocalStoreGarbageCollection,claimPackageObjectDeletion,listCompositionLeases,previewLocalStoreGarbageCollection,recoverInterruptedStoreDeletions,reconcileIdleDeletionClaims,registerStagedPackage,releaseAbandonedCompositionLease,releaseCompositionLease,releasePackageObjectDeletionClaim,removeLocalRetentionPin,resolveLocalPackage,setStoreGcFaultForTests,setStoreWriterLivenessProbeForTests,verifyLocalStore,withLocalStoreReadLock} from "./local-store.ts";
import {buildReleasePackage} from "./release-pipeline.ts";
import {createProjectLock,pinProjectLock,unpinProjectLock} from "./project-lock.ts";
const repositoryRoot=resolve(fileURLToPath(new URL("../../",import.meta.url)));
function makeWritable(directory:string):void{
 if(!existsSync(directory))return;
 for(const entry of readdirSync(directory,{withFileTypes:true})){
  const path=join(directory,entry.name);if(entry.isSymbolicLink())continue;
  if(entry.isDirectory())makeWritable(path);
  try{chmodSync(path,entry.isDirectory()?0o755:0o644);}catch{}
 }
 try{chmodSync(directory,0o755);}catch{}
}
function fixture(t:{after(callback:()=>void):void}):string{
 const root=mkdtempSync(join(tmpdir(),"cgp-retention-gc-test-"));
 t.after(()=>{makeWritable(root);rmSync(root,{recursive:true,force:true});});return root;
}
async function buildStarter(root:string):Promise<string>{
 const source=join(root,"source");mkdirSync(source);
 writeFileSync(join(source,"manifest.json"),readFileSync(join(repositoryRoot,"examples/starter-module/manifest.json")));
 writeFileSync(join(source,"module.ts"),readFileSync(join(repositoryRoot,"examples/starter-module/module.ts")));
 const staging=join(root,"stage");
 await buildReleasePackage({sourceDirectory:source,releaseDirectory:join(root,"release"),stagingDirectory:staging});
 return staging;
}
function profile(){return {profileId:"org.example.retained-project",name:"Retained Project",modules:[{moduleId:"org.example.starter",version:"1.0.0"}]};}
const lifecyclePath=(store:string)=>join(store,".cgp-store-lifecycle.json");

test("registration creates a persistent local-retention pin by default",async t=>{
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 const registered=await registerStagedPackage(staging,store);
 assert.equal(existsSync(lifecyclePath(store)),true);
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 const object=preview.objects.find(x=>x.digest===registered.entry.packageTreeDigest);
 assert.equal(object?.status,"retained");assert.deepEqual(object?.retentionRoots,["local-retention"]);
 assert.equal(preview.candidates.some(x=>x.digest===registered.entry.packageTreeDigest),false);
});

test("legacy stores migrate conservatively and dry-run preview never deletes or rewrites lifecycle state",async t=>{
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 const registered=await registerStagedPackage(staging,store);unlinkSync(lifecyclePath(store));
 const legacy=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 assert.equal(legacy.objects.find(x=>x.digest===registered.entry.packageTreeDigest)?.status,"retained");
 assert.equal(existsSync(lifecyclePath(store)),false);
 await removeLocalRetentionPin(store,registered.entry.packageTreeDigest);
 const before=readFileSync(lifecyclePath(store));
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 assert.equal(preview.dryRun,true);
 assert.equal(preview.candidates.some(x=>x.digest===registered.entry.packageTreeDigest),true);
 assert.ok(preview.candidateBytes>0);assert.equal(existsSync(registered.objectDirectory),true);
 assert.deepEqual(readFileSync(lifecyclePath(store)),before);
});

test("project-lock pin retains exact packages after local-import pin removal",async t=>{
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 const registered=await registerStagedPackage(staging,store),lock=await createProjectLock(store,profile());
 const pin=await pinProjectLock(store,"game:main",lock);
 assert.equal(pin.profileId,lock.profileId);assert.equal(pin.modules[0]?.digest,registered.entry.packageTreeDigest);
 await removeLocalRetentionPin(store,registered.entry.packageTreeDigest);
 const retained=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 const object=retained.objects.find(x=>x.digest===registered.entry.packageTreeDigest);
 assert.equal(object?.status,"retained");assert.deepEqual(object?.retentionRoots,["project:game:main"]);
 assert.equal((await unpinProjectLock(store,"game:main")).removed,true);
 const candidate=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 assert.equal(candidate.candidates.some(x=>x.digest===registered.entry.packageTreeDigest),true);
});

test("project pin creation rejects lock identities that differ from the store",async t=>{
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 await registerStagedPackage(staging,store);
 const lock=await createProjectLock(store,profile());
 const tampered={...lock,modules:[{...lock.modules[0]!,packageTreeDigest:"sha256:"+"0".repeat(64)}]};
 await assert.rejects(pinProjectLock(store,"game:tampered",tampered),/does not match the local catalog/);
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 assert.equal(preview.rootsChecked.projectPins,0);
});

test("deletion claims serialize with pins and block new readers until released",async t=>{
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 const registered=await registerStagedPackage(staging,store),lock=await createProjectLock(store,profile());
 await removeLocalRetentionPin(store,registered.entry.packageTreeDigest);
 const claim=await claimPackageObjectDeletion(store,registered.entry.packageTreeDigest,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 assert.ok(claim.claimToken.length>=16);
 await assert.rejects(resolveLocalPackage(store,"org.example.starter","1.0.0"),/marked deleting/);
 await assert.rejects(addLocalRetentionPin(store,registered.entry.packageTreeDigest),/marked deleting/);
 await assert.rejects(pinProjectLock(store,"game:main",lock),/marked deleting/);
 await assert.rejects(releasePackageObjectDeletionClaim(store,registered.entry.packageTreeDigest,"wrong-claim-token-000"),/does not own/);
 const blocked=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 assert.equal(blocked.objects.find(x=>x.digest===registered.entry.packageTreeDigest)?.status,"deleting");
 assert.equal(blocked.candidates.some(x=>x.digest===registered.entry.packageTreeDigest),false);
 await releasePackageObjectDeletionClaim(store,registered.entry.packageTreeDigest,claim.claimToken);
 assert.equal((await addLocalRetentionPin(store,registered.entry.packageTreeDigest)).added,true);
 assert.equal((await resolveLocalPackage(store,"org.example.starter","1.0.0"))?.entry.packageTreeDigest,registered.entry.packageTreeDigest);
});

test("a locally pinned object cannot be claimed after the grace period",async t=>{
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 const registered=await registerStagedPackage(staging,store);
 await assert.rejects(claimPackageObjectDeletion(store,registered.entry.packageTreeDigest,{gracePeriodMs:0,now:new Date(Date.now()+5000)}),/still retained by: local-retention/);
});

test("corrupt content is invalid and never appears in dry-run candidates",async t=>{
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 const registered=await registerStagedPackage(staging,store);
 await removeLocalRetentionPin(store,registered.entry.packageTreeDigest);
 chmodSync(registered.objectDirectory,0o755);chmodSync(join(registered.objectDirectory,"module.mjs"),0o644);
 writeFileSync(join(registered.objectDirectory,"module.mjs"),"export const implementation = {};\n");
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 assert.equal(preview.objects.find(x=>x.digest===registered.entry.packageTreeDigest)?.status,"invalid");
 assert.equal(preview.candidates.some(x=>x.digest===registered.entry.packageTreeDigest),false);
 assert.equal(existsSync(registered.objectDirectory),true);
});

test("a valid orphan object receives an object state before a new local pin is persisted",async t=>{
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 const registered=await registerStagedPackage(staging,store),digest=registered.entry.packageTreeDigest;
 const catalog=JSON.parse(readFileSync(join(store,"catalog.json"),"utf8")) as {schema:string;entries:unknown[]};
 catalog.entries=[];
 writeFileSync(join(store,"catalog.json"),JSON.stringify(catalog,null,2)+"\n");
 const lifecycle=JSON.parse(readFileSync(lifecyclePath(store),"utf8")) as {
  objects:Array<{digest:string}>;localPins:Array<{digest:string}>;projectPins:unknown[];schema:string
 };
 lifecycle.objects=lifecycle.objects.filter(x=>x.digest!==digest);
 lifecycle.localPins=lifecycle.localPins.filter(x=>x.digest!==digest);
 writeFileSync(lifecyclePath(store),JSON.stringify(lifecycle,null,2)+"\n");

 const pinned=await addLocalRetentionPin(store,digest);
 assert.equal(pinned.added,true);
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:new Date(Date.now()+5000)});
 const object=preview.objects.find(x=>x.digest===digest);
 assert.equal(object?.state,"ready");
 assert.equal(object?.status,"retained");
 assert.deepEqual(object?.retentionRoots,["local-retention"]);
});

const later=()=>new Date(Date.now()+60_000);
function resetGcHooks(t:{after(callback:()=>void):void}):void{
 t.after(()=>{setStoreGcFaultForTests(null);setStoreWriterLivenessProbeForTests(null);});
}
async function unpinnedStore(t:{after(callback:()=>void):void}){
 const root=fixture(t),staging=await buildStarter(root),store=join(root,"store");
 const registered=await registerStagedPackage(staging,store);
 await removeLocalRetentionPin(store,registered.entry.packageTreeDigest);
 return {root,store,registered,digest:registered.entry.packageTreeDigest};
}
function stateOf(store:string,digest:string):string|undefined{
 const lifecycle=JSON.parse(readFileSync(lifecyclePath(store),"utf8")) as {objects:Array<{digest:string;state:string}>};
 return lifecycle.objects.find(item=>item.digest===digest)?.state;
}
function tombstonePath(store:string,digest:string):string{
 return join(store,".cgp-store-tombstones",digest.slice("sha256:".length));
}

test("local and project pins block destructive collection, and one root does not cover the other",async t=>{
 const root=fixture(t),store=join(root,"store");
 const first=await buildStarter(root);
 const secondSource=join(root,"other-source");mkdirSync(secondSource);
 const manifest=JSON.parse(readFileSync(join(repositoryRoot,"examples/starter-module/manifest.json"),"utf8")) as {moduleId:string;name:string};
 manifest.moduleId="org.example.other";manifest.name="Other";
 writeFileSync(join(secondSource,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
 writeFileSync(join(secondSource,"module.ts"),readFileSync(join(repositoryRoot,"examples/starter-module/module.ts")));
 const second=join(root,"other-stage");
 await buildReleasePackage({sourceDirectory:secondSource,releaseDirectory:join(root,"other-release"),stagingDirectory:second});
 const kept=await registerStagedPackage(first,store);
 const dropped=await registerStagedPackage(second,store);
 await removeLocalRetentionPin(store,dropped.entry.packageTreeDigest);
 const blocked=await applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(blocked.deleted.includes(kept.entry.packageTreeDigest),false);
 assert.equal(blocked.deleted.includes(dropped.entry.packageTreeDigest),true);
 assert.equal(existsSync(kept.objectDirectory),true);
 assert.equal(existsSync(dropped.objectDirectory),false);
 const lock=await createProjectLock(store,{profileId:"org.example.retained-project",name:"Retained",modules:[{moduleId:"org.example.starter",version:"1.0.0"}]});
 await removeLocalRetentionPin(store,kept.entry.packageTreeDigest);
 await pinProjectLock(store,"game:main",lock);
 const stillKept=await applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(stillKept.deleted.includes(kept.entry.packageTreeDigest),false);
 assert.equal(existsSync(kept.objectDirectory),true);
 await unpinProjectLock(store,"game:main");
 const removed=await applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.deepEqual(removed.deleted,[kept.entry.packageTreeDigest]);
});

test("a fresh apply rechecks bytes and never deletes from a stale preview",async t=>{
 const {store,registered,digest}=await unpinnedStore(t);
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(preview.dryRun,true);
 assert.equal(preview.candidates.some(item=>item.digest===digest),true);
 chmodSync(registered.objectDirectory,0o755);
 chmodSync(join(registered.objectDirectory,"module.mjs"),0o644);
 writeFileSync(join(registered.objectDirectory,"module.mjs"),"export const implementation = {};\n");
 const applied=await applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(applied.deleted.includes(digest),false);
 assert.equal(existsSync(registered.objectDirectory),true);
 assert.equal(stateOf(store,digest),"ready");
});

test("symlinks and special quarantine entries are not deleted",async t=>{
 const {root,store,registered,digest}=await unpinnedStore(t);
 const canary=join(root,"canary.txt");
 writeFileSync(canary,"keep\n");
 chmodSync(registered.objectDirectory,0o755);
 symlinkSync(canary,join(registered.objectDirectory,"alias"));
 const applied=await applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(applied.deleted.includes(digest),false);
 assert.equal(readFileSync(canary,"utf8"),"keep\n");
 assert.equal(existsSync(registered.objectDirectory),true);
});

test("an active reader blocks object movement",async t=>{
 const {store,registered,digest}=await unpinnedStore(t);
 let releaseReader=():void=>{};
 let entered!:()=>void;
 const readerEntered=new Promise<void>(resolve=>{entered=resolve;});
 const reader=withLocalStoreReadLock(store,async()=>{
  entered();
  await new Promise<void>(resolve=>{releaseReader=resolve;});
 });
 await readerEntered;
 await assert.rejects(
  applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later(),coordination:{waitTimeoutMs:40,pollIntervalMs:5}}),
  /reader markers/,
 );
 releaseReader();
 await reader;
 assert.equal(existsSync(registered.objectDirectory),true);
 assert.notEqual(stateOf(store,digest),"deleted");
});

test("a deletion claim applies once, rejects the wrong token, and blocks a racing pin",async t=>{
 const {store,digest,registered}=await unpinnedStore(t);
 const claim=await claimPackageObjectDeletion(store,digest,{gracePeriodMs:0,now:later()});
 await assert.rejects(addLocalRetentionPin(store,digest),/marked deleting/);
 await assert.rejects(applyClaimedPackageObjectDeletion(store,digest,"wrong-claim-token-000",{gracePeriodMs:0,now:later()}),/does not own/);
 assert.equal(existsSync(registered.objectDirectory),true);
 const applied=await applyClaimedPackageObjectDeletion(store,digest,claim.claimToken,{gracePeriodMs:0,now:later()});
 assert.equal(applied.deleted,true);
 assert.equal(existsSync(registered.objectDirectory),false);
 await assert.rejects(applyClaimedPackageObjectDeletion(store,digest,claim.claimToken,{gracePeriodMs:0,now:later()}),/already deleted/);
 const catalog=readFileSync(join(store,"catalog.json"),"utf8");
 assert.match(catalog,/org\.example\.starter/);
 assert.equal(stateOf(store,digest),"deleted");
});

test("interrupted deletion recovers from every persisted boundary and is idempotent",async t=>{
 resetGcHooks(t);
 const boundaries=["before-intent","after-intent","after-move","during-removal","after-bytes-removed"] as const;
 for(const boundary of boundaries){
  const {store,registered,digest}=await unpinnedStore(t);
  setStoreGcFaultForTests(boundary);
  await assert.rejects(applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),new RegExp("Injected store GC fault: "+boundary));
  if(boundary==="before-intent"){
   assert.equal(existsSync(registered.objectDirectory),true);
   assert.equal(existsSync(tombstonePath(store,digest)),false);
   assert.equal(stateOf(store,digest),"ready");
   const recovered=await recoverInterruptedStoreDeletions(store,{now:later()});
   assert.equal(recovered.completed.includes(digest),false);
   assert.equal(existsSync(registered.objectDirectory),true);
   continue;
  }
  if(boundary==="after-intent")assert.equal(stateOf(store,digest),"intent");
  if(boundary==="after-move"){
   assert.equal(stateOf(store,digest),"intent");
   assert.equal(existsSync(registered.objectDirectory),false);
   assert.equal(lstatSync(tombstonePath(store,digest)).isDirectory(),true);
  }
  if(boundary==="during-removal"||boundary==="after-bytes-removed")assert.equal(stateOf(store,digest),"removing");
  const recovered=await recoverInterruptedStoreDeletions(store,{now:later()});
  assert.equal(recovered.completed.includes(digest),true);
  assert.equal(existsSync(registered.objectDirectory),false);
  assert.equal(existsSync(tombstonePath(store,digest)),false);
  assert.equal(stateOf(store,digest),"deleted");
  const again=await recoverInterruptedStoreDeletions(store,{now:later()});
  assert.equal(again.completed.includes(digest),false);
  assert.equal(stateOf(store,digest),"deleted");
  assert.match(readFileSync(join(store,"catalog.json"),"utf8"),/org\.example\.starter/);
 }
});

test("ambiguous object and tombstone pairs are left untouched",async t=>{
 resetGcHooks(t);
 const {store,registered,digest}=await unpinnedStore(t);
 setStoreGcFaultForTests("after-intent");
 await assert.rejects(applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/after-intent/);
 mkdirSync(tombstonePath(store,digest),{recursive:true});
 writeFileSync(join(tombstonePath(store,digest),"marker"),"both\n");
 const recovered=await recoverInterruptedStoreDeletions(store,{now:later()});
 assert.equal(recovered.ambiguous.some(item=>item.digest===digest),true);
 assert.equal(existsSync(registered.objectDirectory),true);
 assert.equal(readFileSync(join(tombstonePath(store,digest),"marker"),"utf8"),"both\n");
 const second=await recoverInterruptedStoreDeletions(store,{now:later()});
 assert.equal(second.ambiguous.some(item=>item.digest===digest),true);
 assert.equal(existsSync(join(tombstonePath(store,digest),"marker")),true);
 assert.equal(stateOf(store,digest),"ambiguous");
});

test("a tombstone symlink is refused and its target is not removed",async t=>{
 resetGcHooks(t);
 const {root,store,digest}=await unpinnedStore(t);
 setStoreGcFaultForTests("after-move");
 await assert.rejects(applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/after-move/);
 const canary=join(root,"outside.txt");
 writeFileSync(canary,"outside\n");
 chmodSync(tombstonePath(store,digest),0o755);
 symlinkSync(canary,join(tombstonePath(store,digest),"linked"));
 const recovered=await recoverInterruptedStoreDeletions(store,{now:later()});
 assert.equal(recovered.refused.some(item=>item.digest===digest),true);
 assert.equal(readFileSync(canary,"utf8"),"outside\n");
 assert.equal(existsSync(join(tombstonePath(store,digest),"linked")),true);
});

test("idle claims stay with their token owner unless that claim is explicitly cancelled",async t=>{
 resetGcHooks(t);
 const {store,digest,registered}=await unpinnedStore(t);
 const claim=await claimPackageObjectDeletion(store,digest,{gracePeriodMs:0,now:later()});
 setStoreWriterLivenessProbeForTests(()=>false);
 const held=await reconcileIdleDeletionClaims(store,{now:later(),digest});
 assert.deepEqual(held.released,[]);
 assert.equal(held.retained[0]?.digest,digest);
 assert.match(held.retained[0]?.reason??"",/token owner/);
 assert.equal(stateOf(store,digest),"deleting");
 assert.equal(existsSync(registered.objectDirectory),true);
 await assert.rejects(reconcileIdleDeletionClaims(store,{now:later(),cancelClaim:"sha256:"+"0".repeat(64)}),/did not change other claims/);
 assert.equal(stateOf(store,digest),"deleting");
 const cancelled=await reconcileIdleDeletionClaims(store,{now:later(),cancelClaim:digest});
 assert.deepEqual(cancelled.released,[digest]);
 assert.equal(existsSync(registered.objectDirectory),true);
 assert.equal(stateOf(store,digest),"ready");
 await releasePackageObjectDeletionClaim(store,digest,claim.claimToken).then(()=>assert.fail("released claim must not still match"),()=>{});
 const again=await claimPackageObjectDeletion(store,digest,{gracePeriodMs:0,now:later()});
 await releasePackageObjectDeletionClaim(store,digest,again.claimToken);
 assert.equal(stateOf(store,digest),"ready");
 setStoreGcFaultForTests("after-intent");
 await assert.rejects(applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/after-intent/);
 const left=await reconcileIdleDeletionClaims(store,{now:later()});
 assert.equal(left.released.includes(digest),false);
 assert.equal(left.leftInProgress.includes(digest),true);
 assert.equal(stateOf(store,digest),"intent");
 const lifecycle=JSON.parse(readFileSync(lifecyclePath(store),"utf8")) as {objects:Array<{deletionIntent?:{writerToken:string}}>};
 const writerToken=lifecycle.objects[0]?.deletionIntent?.writerToken;
 assert.ok(writerToken);
 const lockPath=join(store,".cgp-store.lock");
 writeFileSync(lockPath,JSON.stringify({schema:"cgp.local-store-lock/1",token:writerToken,pid:2147483646,createdAt:new Date(0).toISOString()})+"\n");
 setStoreWriterLivenessProbeForTests(()=>true);
 await assert.rejects(recoverInterruptedStoreDeletions(store,{now:later()}),/may still be active/);
 assert.equal(existsSync(registered.objectDirectory),true);
 assert.equal(existsSync(lockPath),true);
 setStoreWriterLivenessProbeForTests(()=>false);
 writeFileSync(lockPath,JSON.stringify({schema:"cgp.local-store-lock/1",token:"0123456789abcdef",pid:2147483646,createdAt:new Date(0).toISOString()})+"\n");
 await assert.rejects(recoverInterruptedStoreDeletions(store,{now:later()}),/does not match a durable/);
 assert.equal(existsSync(lockPath),true);
 writeFileSync(lockPath,JSON.stringify({schema:"cgp.local-store-lock/1",token:writerToken,pid:2147483646,createdAt:new Date(0).toISOString()})+"\n");
 const recovered=await recoverInterruptedStoreDeletions(store,{now:later()});
 assert.equal(recovered.completed.includes(digest),true);
 assert.equal(existsSync(lockPath),false);
 assert.equal(stateOf(store,digest),"deleted");
});

test("legacy v1 lifecycle files stay readable and destructive commands require --apply",async t=>{
 const {store,digest,registered}=await unpinnedStore(t);
 const raw=JSON.parse(readFileSync(lifecyclePath(store),"utf8")) as {schema:string};
 raw.schema="cgp.local-store-lifecycle/1";
 writeFileSync(lifecyclePath(store),JSON.stringify(raw,null,2)+"\n");
 const before=readFileSync(lifecyclePath(store));
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(preview.candidates.some(item=>item.digest===digest),true);
 assert.deepEqual(readFileSync(lifecyclePath(store)),before);
 const missing=spawnSync(process.execPath,["--experimental-strip-types","scripts/apply-store-gc.ts","--store",store],{cwd:repositoryRoot,encoding:"utf8"});
 assert.notEqual(missing.status,0);
 assert.match(missing.stderr,/--apply/);
 assert.equal(existsSync(registered.objectDirectory),true);
 const applied=spawnSync(process.execPath,["--experimental-strip-types","scripts/apply-store-gc.ts","--store",store,"--apply","--grace-hours","0"],{cwd:repositoryRoot,encoding:"utf8"});
 assert.equal(applied.status,0,applied.stderr);
 assert.equal(existsSync(registered.objectDirectory),false);
 const catalog=readFileSync(join(store,"catalog.json"),"utf8");
 assert.match(catalog,/org\.example\.starter/);
 const restored=await registerStagedPackage(join(store,"..","stage"),store);
 assert.equal(restored.entry.packageTreeDigest,digest);
 assert.equal((await resolveLocalPackage(store,"org.example.starter","1.0.0"))?.entry.packageTreeDigest,digest);
 const verification=await verifyLocalStore(store);
 assert.equal(verification.errors.length,0);
});

const leaseDirectory=(store:string)=>join(store,".cgp-store.composition-leases");
const leaseFile=(store:string,leaseId:string)=>join(leaseDirectory(store),leaseId+".json");

test("a composition lease retains an unpinned object until its token is released",async t=>{
 const {store,registered,digest}=await unpinnedStore(t);
 await assert.rejects(acquireCompositionLease(store,[]),/at least one package digest/);
 await assert.rejects(acquireCompositionLease(store,["sha256:"+"0".repeat(63)]),/Invalid package-tree/);
 const lease=await acquireCompositionLease(store,[digest,digest]);
 assert.match(lease.leaseId,/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
 assert.equal(lease.digests.length,1);
 const listed=await listCompositionLeases(store);
 assert.equal(listed.length,1);
 assert.equal(Object.hasOwn(listed[0]!,"token"),false);
 assert.deepEqual(listed[0]!.digests,[digest]);
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 const object=preview.objects.find(item=>item.digest===digest);
 assert.equal(object?.status,"retained");
 assert.deepEqual(object?.retentionRoots,["composition:"+lease.leaseId]);
 assert.equal(preview.rootsChecked.compositionLeases,1);
 const applied=await applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(applied.deleted.includes(digest),false);
 assert.equal(existsSync(registered.objectDirectory),true);
 await assert.rejects(claimPackageObjectDeletion(store,digest,{gracePeriodMs:0,now:later()}),/still retained by: composition:/);
 await assert.rejects(releaseCompositionLease(store,lease.leaseId,"0123456789abcdef"),/does not own/);
 assert.equal(existsSync(leaseFile(store,lease.leaseId)),true);
 assert.equal((await releaseCompositionLease(store,lease.leaseId,lease.token)).released,true);
 assert.equal((await releaseCompositionLease(store,lease.leaseId,lease.token)).released,false);
 const candidate=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(candidate.candidates.some(item=>item.digest===digest),true);
});

test("one composition lease does not retain an object held only by another",async t=>{
 const root=fixture(t),store=join(root,"store");
 const firstStage=await buildStarter(root);
 const secondSource=join(root,"other-source");mkdirSync(secondSource);
 const manifest=JSON.parse(readFileSync(join(repositoryRoot,"examples/starter-module/manifest.json"),"utf8")) as {moduleId:string;name:string};
 manifest.moduleId="org.example.other";manifest.name="Other";
 writeFileSync(join(secondSource,"manifest.json"),JSON.stringify(manifest,null,2)+"\n");
 writeFileSync(join(secondSource,"module.ts"),readFileSync(join(repositoryRoot,"examples/starter-module/module.ts")));
 const secondStage=join(root,"other-stage");
 await buildReleasePackage({sourceDirectory:secondSource,releaseDirectory:join(root,"other-release"),stagingDirectory:secondStage});
 const kept=await registerStagedPackage(firstStage,store);
 const dropped=await registerStagedPackage(secondStage,store);
 await removeLocalRetentionPin(store,kept.entry.packageTreeDigest);
 await removeLocalRetentionPin(store,dropped.entry.packageTreeDigest);
 const first=await acquireCompositionLease(store,[kept.entry.packageTreeDigest]);
 const second=await acquireCompositionLease(store,[kept.entry.packageTreeDigest]);
 await releaseCompositionLease(store,first.leaseId,first.token);
 const stillKept=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.deepEqual(stillKept.objects.find(item=>item.digest===kept.entry.packageTreeDigest)?.retentionRoots,["composition:"+second.leaseId]);
 const applied=await applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(applied.deleted.includes(kept.entry.packageTreeDigest),false);
 assert.equal(applied.deleted.includes(dropped.entry.packageTreeDigest),true);
 assert.equal(existsSync(kept.objectDirectory),true);
 assert.equal(existsSync(dropped.objectDirectory),false);
 await releaseCompositionLease(store,second.leaseId,second.token);
 const open=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(open.candidates.some(item=>item.digest===kept.entry.packageTreeDigest),true);
});

test("abandoned composition-lease release refuses a live or unknown pid and does not delete bytes",async t=>{
 resetGcHooks(t);
 const {store,digest,registered}=await unpinnedStore(t);
 const lease=await acquireCompositionLease(store,[digest]);
 await assert.rejects(releaseAbandonedCompositionLease(store,lease.leaseId),/may still be active/);
 setStoreWriterLivenessProbeForTests(()=>"unknown");
 await assert.rejects(releaseAbandonedCompositionLease(store,lease.leaseId),/may still be active/);
 assert.equal(existsSync(leaseFile(store,lease.leaseId)),true);
 assert.equal(existsSync(registered.objectDirectory),true);
 setStoreWriterLivenessProbeForTests(()=>false);
 const dropped=await releaseAbandonedCompositionLease(store,lease.leaseId);
 assert.deepEqual(dropped.digests,[digest]);
 assert.equal(existsSync(leaseFile(store,lease.leaseId)),false);
 assert.equal(existsSync(registered.objectDirectory),true);
 const preview=await previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()});
 assert.equal(preview.candidates.some(item=>item.digest===digest),true);
 await assert.rejects(releaseAbandonedCompositionLease(store,lease.leaseId),/does not exist/);
});

test("malformed composition leases fail closed and a deleting object cannot be leased",async t=>{
 const {store,digest,registered}=await unpinnedStore(t);
 const directory=leaseDirectory(store);
 mkdirSync(directory,{mode:0o700});
 writeFileSync(join(directory,"notes.txt"),"nope\n");
 await assert.rejects(previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/unexpected entry/);
 await assert.rejects(applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/unexpected entry/);
 assert.equal(existsSync(registered.objectDirectory),true);
 unlinkSync(join(directory,"notes.txt"));
 const id="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
 writeFileSync(join(directory,id+".json"),JSON.stringify({
  schema:"cgp.store-composition-lease/1",leaseId:id,token:"0123456789abcdef",pid:1,
  createdAt:new Date(0).toISOString(),digests:[digest,digest],
 })+"\n");
 await assert.rejects(previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/invalid or duplicate digest/);
 await assert.rejects(applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/invalid or duplicate digest/);
 assert.equal(existsSync(registered.objectDirectory),true);
 unlinkSync(join(directory,id+".json"));
 rmSync(directory,{recursive:true,force:true});
 symlinkSync(store,directory);
 try{
  await assert.rejects(previewLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/must be a real directory/);
  await assert.rejects(applyLocalStoreGarbageCollection(store,{gracePeriodMs:0,now:later()}),/must be a real directory/);
  assert.equal(existsSync(registered.objectDirectory),true);
 }finally{unlinkSync(directory);}
 const claim=await claimPackageObjectDeletion(store,digest,{gracePeriodMs:0,now:later()});
 await assert.rejects(acquireCompositionLease(store,[digest]),/marked deleting/);
 assert.equal(existsSync(registered.objectDirectory),true);
 assert.equal(existsSync(directory),false);
 await releasePackageObjectDeletionClaim(store,digest,claim.claimToken);
});

test("composition-lease commands list and release without deleting bytes",async t=>{
 const {store,digest,registered}=await unpinnedStore(t);
 const lease=await acquireCompositionLease(store,[digest]);
 const run=(...args:string[])=>spawnSync(process.execPath,["--experimental-strip-types","scripts/manage-composition-leases.ts",...args],{cwd:repositoryRoot,encoding:"utf8"});
 const listed=run("--store",store,"--action","list");
 assert.equal(listed.status,0,listed.stderr);
 assert.match(listed.stdout,new RegExp(lease.leaseId));
 assert.doesNotMatch(listed.stdout,new RegExp(lease.token));
 const premature=run("--store",store,"--action","release-abandoned","--lease",lease.leaseId);
 assert.notEqual(premature.status,0);
 assert.match(premature.stderr,/--apply/);
 const wrong=run("--store",store,"--action","release","--lease",lease.leaseId,"--token","0123456789abcdef");
 assert.notEqual(wrong.status,0);
 assert.match(wrong.stderr,/does not own/);
 assert.equal(existsSync(leaseFile(store,lease.leaseId)),true);
 const released=run("--store",store,"--action","release","--lease",lease.leaseId,"--token",lease.token);
 assert.equal(released.status,0,released.stderr);
 assert.match(released.stdout,/does not delete package bytes/);
 assert.equal(existsSync(registered.objectDirectory),true);
 const abandonedId="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
 writeFileSync(leaseFile(store,abandonedId),JSON.stringify({
  schema:"cgp.store-composition-lease/1",leaseId:abandonedId,token:"0123456789abcdef",pid:2147483646,
  createdAt:new Date(0).toISOString(),digests:[digest],
 })+"\n");
 const abandoned=run("--store",store,"--action","release-abandoned","--apply","--lease",abandonedId);
 assert.equal(abandoned.status,0,abandoned.stderr);
 assert.match(abandoned.stdout,/were not deleted/);
 assert.equal(existsSync(leaseFile(store,abandonedId)),false);
 assert.equal(existsSync(registered.objectDirectory),true);
});

test("reconcile refuses to sweep token-owned claims and cancellation names one digest",async t=>{
 const {store,digest,registered}=await unpinnedStore(t);
 const claim=await claimPackageObjectDeletion(store,digest,{gracePeriodMs:0,now:later()});
 const run=(...args:string[])=>spawnSync(process.execPath,["--experimental-strip-types","scripts/reconcile-store-claims.ts","--store",store,...args],{cwd:repositoryRoot,encoding:"utf8"});
 const listed=run("--apply","--digest",digest);
 assert.equal(listed.status,0,listed.stderr);
 assert.match(listed.stdout,/left in place/);
 assert.equal(stateOf(store,digest),"deleting");
 const sweep=run("--apply","--cancel-claim");
 assert.notEqual(sweep.status,0);
 assert.match(sweep.stderr,/requires --digest/);
 assert.equal(stateOf(store,digest),"deleting");
 const cancelled=run("--apply","--cancel-claim","--digest",digest);
 assert.equal(cancelled.status,0,cancelled.stderr);
 assert.match(cancelled.stdout,/no longer owns it/);
 assert.equal(stateOf(store,digest),"ready");
 assert.equal(existsSync(registered.objectDirectory),true);
 await assert.rejects(releasePackageObjectDeletionClaim(store,digest,claim.claimToken),/does not own/);
});

