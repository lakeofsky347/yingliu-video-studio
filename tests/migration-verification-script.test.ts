import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {migrationVerificationOptions,assertMigrationProjectRoot,assertRestoredMigrationFixture,redactMigrationMessage} from '../scripts/verify-migration-20261111.mjs';

test('migration verifier requires explicit host and project isolation instead of reading an old artifact',async()=>{
  await assert.rejects(migrationVerificationOptions({}),/MIGRATION_HOST_URL or MIGRATION_HOST_LOG/);
  await assert.rejects(migrationVerificationOptions({MIGRATION_HOST_URL:'http://127.0.0.1:19405/'}),/MIGRATION_PROJECTS_DIR/);
  await assert.rejects(migrationVerificationOptions({MIGRATION_HOST_URL:'https://example.org/'}),/loopback/);
  const env={MIGRATION_HOST_URL:'http://127.0.0.1:19405/?token=fixture#auth',MIGRATION_PROJECTS_DIR:path.join(os.tmpdir(),'isolated-projects'),MIGRATION_BROWSER_PATH:process.execPath};
  const first=await migrationVerificationOptions(env),second=await migrationVerificationOptions(env);
  assert.equal(first.url,env.MIGRATION_HOST_URL);assert.equal(first.browserPath,process.execPath);assert.equal(first.projects,path.resolve(env.MIGRATION_PROJECTS_DIR));assert.notEqual(first.out,second.out);
  await assert.rejects(migrationVerificationOptions({...env,MIGRATION_BROWSER_PATH:path.join(os.tmpdir(),'missing-fixture-browser')}),/MIGRATION_BROWSER_PATH/);
});

test('migration verifier uses the requested log and latest host URL without overwriting old reports',async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'migration-script-'));
  try{
    const log=path.join(directory,'host.log');await fs.writeFile(log,'dsh web: http://127.0.0.1:19001/?token=old\ndsh web: http://127.0.0.1:19002/?token=new\n');
    const options=await migrationVerificationOptions({MIGRATION_HOST_LOG:log,MIGRATION_PROJECTS_DIR:directory,MIGRATION_BROWSER_PATH:process.execPath,MIGRATION_REPORT_DIR:path.join(directory,'run'),MIGRATION_RESTORE_PROJECT_ID:'previous-fixture'});
    assert.equal(options.url,'http://127.0.0.1:19002/?token=new');assert.equal(options.out,path.join(directory,'run'));assert.equal(options.restoreProjectId,'previous-fixture');
    const root=path.join(directory,'projects'),project=path.join(root,'one'),outside=path.join(directory,'projects-other');await fs.mkdir(project,{recursive:true});await fs.mkdir(outside);
    assert.doesNotThrow(()=>assertMigrationProjectRoot(project,root));assert.throws(()=>assertMigrationProjectRoot(outside,root),/outside/);assert.throws(()=>assertMigrationProjectRoot(root,root),/outside/);
  }finally{await fs.rm(directory,{recursive:true,force:true});}
});

test('migration verifier checks restoration only for the explicitly named prior fixture and removes URL secrets',()=>{
  const unrelated={project:{id:'ordinary-project',outputs:[{}],audioClips:[],extensions:{}}};
  assert.equal(assertRestoredMigrationFixture(unrelated),false);
  assert.throws(()=>assertRestoredMigrationFixture(unrelated,'previous-fixture'),/MIGRATION_RESTORE_PROJECT_ID/);
  const restored={project:{id:'previous-fixture',outputs:[{}],audioClips:[{}],extensions:{directorDocument:{status:'approved'}}}};
  assert.equal(assertRestoredMigrationFixture(restored,'previous-fixture'),true);
  const message=redactMigrationMessage('Navigation failed http://127.0.0.1:19405/?token=private#auth and http://name:password@localhost:19405/api?secret=key');
  assert.equal(message,'Navigation failed http://127.0.0.1:19405/ and http://localhost:19405/api');
  assert.doesNotMatch(message,/private|password|secret|auth/);
});
