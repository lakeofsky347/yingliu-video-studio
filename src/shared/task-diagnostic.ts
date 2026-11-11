/** Only fixed labels cross the diagnostic boundary; messages and paths stay out. */
export const FAILURE_CATEGORIES=['IO_ERROR','FRAME_NOT_REPEATABLE','WAIT_TIMEOUT','SANDBOX_UNAVAILABLE','CANCELLED','UNKNOWN'] as const;
export const FAILURE_OPERATIONS=['runtime_directory_create','runtime_scene_source_read','runtime_scene_publish','runtime_code_spec_publish','runtime_code_document_publish','runtime_frame_publish','runtime_spec_publish','runtime_index_publish','render_browser_launch','render_page_load','render_scene_ready','render_frame','render_seek','render_check','render_report_write','source_mark_good','preview_refresh','task_journal_start','task_work','task_journal_finish'] as const;
export const IO_CODES=['EPERM','EACCES','EBUSY','ENOENT','ENOSPC','EIO','EMFILE','ENFILE','EXDEV','EEXIST','ENOTDIR','EISDIR','EROFS','ETXTBSY','ENAMETOOLONG','EINVAL','ENOTEMPTY'] as const;
export const IO_SYSCALLS=['open','read','write','fsync','fdatasync','rename','mkdir','stat','lstat','fstat','access','unlink','rmdir','copyfile','scandir','close'] as const;
export interface TaskFailureDiagnostic {category:typeof FAILURE_CATEGORIES[number];operation:typeof FAILURE_OPERATIONS[number];ioCode?:typeof IO_CODES[number];syscall?:typeof IO_SYSCALLS[number]}
const includes=<T extends string>(values:readonly T[],value:unknown):value is T=>typeof value==='string'&&values.includes(value as T);
export function sanitizeTaskFailure(value:unknown):TaskFailureDiagnostic|undefined{
  if(!value||typeof value!=='object')return;const input=value as Record<string,unknown>;
  if(!includes(FAILURE_CATEGORIES,input.category)||!includes(FAILURE_OPERATIONS,input.operation))return;
  return {category:input.category,operation:input.operation,...(includes(IO_CODES,input.ioCode)?{ioCode:input.ioCode}:{}),...(includes(IO_SYSCALLS,input.syscall)?{syscall:input.syscall}:{})};
}
export function taskFailure(error:unknown,operation:TaskFailureDiagnostic['operation']):TaskFailureDiagnostic{
  const input=error&&typeof error==='object'?error as Record<string,unknown>:{},previous=sanitizeTaskFailure(input.failure);
  const ioCode=includes(IO_CODES,input.code)?input.code:previous?.ioCode,syscall=includes(IO_SYSCALLS,input.syscall)?input.syscall:previous?.syscall;
  const message=error instanceof Error?error.message:'';
  const category=ioCode?'IO_ERROR':previous?.category??(/not repeatable/i.test(message)?'FRAME_NOT_REPEATABLE':/timeout|timed out|超时/i.test(message)?'WAIT_TIMEOUT':/sandbox/i.test(message)?'SANDBOX_UNAVAILABLE':input.name==='AbortError'||/^(?:Task cancelled|用户已取消)$/.test(message)?'CANCELLED':'UNKNOWN');
  return {category,operation:previous?.operation??operation,...(ioCode?{ioCode}:{}),...(syscall?{syscall}:{})};
}
export function withTaskFailure(error:unknown,operation:TaskFailureDiagnostic['operation']):Error&{failure:TaskFailureDiagnostic}{
  const original=error instanceof Error?error:new Error(String(error)),failure=taskFailure(error,operation);
  try{return Object.assign(original,{failure});}
  catch{
    const wrapped=new Error(original.message,{cause:original});
    for(const key of ['name','stack','code','syscall','errno','path','dest','shotId','frame']){
      try{const value=(original as unknown as Record<string,unknown>)[key];if(value!==undefined)Object.defineProperty(wrapped,key,{value,writable:true,configurable:true});}catch{}
    }
    return Object.assign(wrapped,{failure});
  }
}
