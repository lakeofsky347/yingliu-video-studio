import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicRename } from '../host/atomic-rename.ts';
import { syncDirectory } from '../host/directory-sync.ts';

/** Publish complete bytes before acknowledging a checkpoint; preserve platform filesystem policies. */
export async function writeDurableFile(file:string,data:string|Uint8Array):Promise<void> {
  const directory=dirname(file);await mkdir(directory,{recursive:true});
  const temporary=file+'.tmp-'+randomUUID();
  try {
    const handle=await open(temporary,'wx',0o600);
    try {await handle.writeFile(data);await handle.sync();} finally {await handle.close();}
    await atomicRename(temporary,file);
    await syncDirectory(directory);await syncDirectory(dirname(directory));
  } finally {await rm(temporary,{force:true});}
}
