import fs from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';

interface AtomicRenameOptions {
  platform?:NodeJS.Platform;
  rename?:(source:string,destination:string)=>Promise<void>;
  delay?:(milliseconds:number)=>Promise<void>;
}

const retryDelays=[10,20,40,80,160,320] as const;

/** Retry transient Windows replacement locks without removing the committed target. */
export async function atomicRename(source:string,destination:string,options:AtomicRenameOptions={}):Promise<void> {
  const platform=options.platform??process.platform,rename=options.rename??fs.rename;
  const delay=options.delay??(async(milliseconds:number)=>{await setTimeout(milliseconds);});
  for(let attempt=0;;attempt++){
    try{await rename(source,destination);return;}
    catch(error){
      const code=(error as NodeJS.ErrnoException)?.code;
      if(platform!=='win32'||!['EPERM','EACCES','EBUSY'].includes(code??'')||attempt>=retryDelays.length)throw error;
      await delay(retryDelays[attempt]!);
    }
  }
}
