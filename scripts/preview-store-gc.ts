import {resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {previewLocalStoreGarbageCollection} from "../src/packages/local-store.ts";
type Args={store?:string;dryRun:boolean;graceHours:number};
function parse(args:string[]):Args{
 const result:Args={dryRun:false,graceHours:24};
 for(let i=0;i<args.length;i++){
  const flag=args[i]!;if(flag==="--dry-run"){result.dryRun=true;continue;}
  const value=args[i+1];if(!value||value.startsWith("--"))throw new Error("Missing value for "+flag+".");
  if(flag==="--store")result.store=value;else if(flag==="--grace-hours")result.graceHours=Number(value);else throw new Error("Unknown argument: "+flag);i++;
 }
 if(!result.store||!result.dryRun)throw new Error("Usage: npm run store:gc-preview -- --store <store-dir> --dry-run [--grace-hours 24]. This command never deletes.");
 if(!Number.isFinite(result.graceHours)||result.graceHours<0||!Number.isSafeInteger(result.graceHours*3600000))throw new Error("--grace-hours must be non-negative and convert to safe integer milliseconds.");
 return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=parse(process.argv.slice(2));const preview=await previewLocalStoreGarbageCollection(args.store!,{gracePeriodMs:args.graceHours*3600000});console.log(JSON.stringify(preview,null,2));console.log("\nDry run only: no package object was claimed or deleted.");}
 catch(error){console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}
}
