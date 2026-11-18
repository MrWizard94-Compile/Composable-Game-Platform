import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {parseStrictJson} from "../src/packages/package-format.ts";
import {addLocalRetentionPin,removeLocalRetentionPin} from "../src/packages/local-store.ts";
import {pinProjectLock,unpinProjectLock} from "../src/packages/project-lock.ts";
type Action="pin-project"|"unpin-project"|"pin-local"|"unpin-local";
type Args={store?:string;action?:Action;projectId?:string;lock?:string;digest?:string};
function parse(args:string[]):Args{
 const result:Args={};
 for(let i=0;i<args.length;i++){
  const flag=args[i]!,value=args[i+1];if(!value||value.startsWith("--"))throw new Error("Missing value for "+flag+".");
  if(flag==="--store")result.store=value;
  else if(flag==="--action"){
   if(value!=="pin-project"&&value!=="unpin-project"&&value!=="pin-local"&&value!=="unpin-local")throw new Error("Unknown retention action: "+value);
   result.action=value;
  }else if(flag==="--project-id")result.projectId=value;
  else if(flag==="--lock")result.lock=value;
  else if(flag==="--digest")result.digest=value;
  else throw new Error("Unknown argument: "+flag);
  i++;
 }
 return result;
}
function readJson(path:string):unknown{const parsed=parseStrictJson(new Uint8Array(readFileSync(path)),path);if(!parsed.ok)throw new Error(parsed.error);return parsed.value;}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const args=parse(process.argv.slice(2));
  if(!args.store||!args.action)throw new Error("Usage: npm run store:retention -- --store <store-dir> --action <pin-project|unpin-project|pin-local|unpin-local> [--project-id <id>] [--lock <lock.json>] [--digest sha256:<hex>]");
  let result:unknown;
  if(args.action==="pin-project"){if(!args.projectId||!args.lock)throw new Error("pin-project requires --project-id and --lock.");result=await pinProjectLock(args.store,args.projectId,readJson(args.lock));}
  else if(args.action==="unpin-project"){if(!args.projectId)throw new Error("unpin-project requires --project-id.");result=await unpinProjectLock(args.store,args.projectId);}
  else if(args.action==="pin-local"){if(!args.digest)throw new Error("pin-local requires --digest.");result=await addLocalRetentionPin(args.store,args.digest);}
  else{if(!args.digest)throw new Error("unpin-local requires --digest.");result=await removeLocalRetentionPin(args.store,args.digest);}
  console.log(JSON.stringify(result,null,2));
 }catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
