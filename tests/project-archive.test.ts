import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {unzipSync} from 'fflate';
import {createProject,defaultSceneSource} from '../src/core/index.ts';
import {ProjectStore} from '../src/host/store.ts';
import {exportProjectArchive,importProjectArchive} from '../src/host/project-archive.ts';

test('host path archive preserves sourced media and reopens under a new unapproved project',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'yingliu-archive-test-'));
  try{
    const store=new ProjectStore({baseDirectory:directory}),original=createProject('工程备份','可编辑短片','code_animation');
    const id=original.shots[0]!.id,bytes=Buffer.from('fixture-image');
    original.assets.push({id:'image',kind:'image',name:'镜头图',description:'镜头图',path:'assets/image.png'});
    original.shots[0]!.assetIds=['image'];
    original.sessionIds=['private-session'];
    original.extensions.sessionIds=['private-session'];
    original.extensions.mediaApplications={old:true};
    const source={...defaultSceneSource(),html:'<p>原始镜头</p>'};
    const saved=await store.create({project:original,sources:[{shotId:id,source}],assetFiles:[{path:'assets/image.png',dataBase64:bytes.toString('base64')}]});
    const archive=await exportProjectArchive(store,saved.root,saved.project);
    const packed=await readFile(archive.path),files=unzipSync(packed);
    assert.deepEqual(Buffer.from(files['assets/image.png']!),bytes);
    assert.doesNotMatch(Buffer.from(files['project.json']!).toString(),/private-session|mediaApplications/);
    const reopened=await importProjectArchive(store,archive.path);
    assert.notEqual(reopened.project.id,saved.project.id);
    assert.equal(reopened.project.productionPolicy?.mode,'unresolved');
    assert.equal(reopened.project.shots[0]?.id,id);
    assert.equal((await store.readSource(reopened.root,reopened.project.shots[0]!)).html,source.html);
    assert.deepEqual(await readFile(join(reopened.root,'assets/image.png')),bytes);
    const broken=join(directory,'broken.yingliu');
    await writeFile(broken,packed.subarray(0,-4));
    await assert.rejects(importProjectArchive(store,broken),/截断|ZIP/);
  }finally{await rm(directory,{recursive:true,force:true});}
});
