export interface MigrationVerificationOptions {
  url:string;browserPath:string;projects:string;out:string;restoreProjectId?:string;
}
export function migrationVerificationOptions(env?:NodeJS.ProcessEnv):Promise<MigrationVerificationOptions>;
export function assertMigrationProjectRoot(root:string,projects:string):void;
export function assertRestoredMigrationFixture(snapshot:any,projectId?:string):boolean;
export function redactMigrationMessage(message:unknown):string;
export function verifyMigration(options?:MigrationVerificationOptions):Promise<Record<string,unknown>>;
