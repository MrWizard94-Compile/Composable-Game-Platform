import assert from "node:assert/strict";
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,unlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";
import {addLocalRetentionPin,claimPackageObjectDeletion,previewLocalStoreGarbageCollection,registerStagedPackage,releasePackageObjectDeletionClaim,removeLocalRetentionPin,resolveLocalPackage} from "./local-store.ts";
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
