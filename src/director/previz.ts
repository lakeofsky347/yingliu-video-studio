import type {Asset,VideoProject} from '../shared/types.ts';
import {previzAssetIds,type PrevizRecord,type PrevizScope} from '../shared/previz.ts';
import {readDirectorDocument} from './document.ts';

export const PREVIZ_EXTENSION='previzApprovals';

export function approvedPrevizScope(project:VideoProject,shotId:string):PrevizScope|null{
  const document=readDirectorDocument(project);
  if(document?.status!=='approved'||!document.plan.shots.some(shot=>shot.shotId===shotId)||!project.shots.some(shot=>shot.id===shotId))return null;
  return {shotId,documentVersion:document.version,documentHash:document.hash};
}

export function projectPrevizRecords(project:VideoProject):PrevizRecord[]{
  const value=project.extensions[PREVIZ_EXTENSION];
  return Array.isArray(value)?value.filter(item=>item&&typeof item==='object'&&typeof item.shotId==='string'):[];
}

export function previewAssets(project:VideoProject,record:PrevizRecord):Asset[]|undefined{
  const ids=previzAssetIds(record);
  if(!record.imageAssetId||new Set(ids).size!==ids.length)return;
  const assets=ids.map(id=>project.assets.find(asset=>asset.id===id&&asset.path&&asset.provenance?.origin==='code_render'&&asset.provenance.usage==='reference_only'));
  if(assets.some((asset,index)=>asset?.kind!==(ids[index]===record.videoAssetId?'video':'image')))return;
  return assets as Asset[];
}

export function matchingPrevizRecord(project:VideoProject,scope:PrevizScope):PrevizRecord|null{
  const record=projectPrevizRecords(project).find(item=>item.shotId===scope.shotId);
  if(!record||record.projectId!==project.id||record.documentVersion!==scope.documentVersion||record.documentHash!==scope.documentHash)return null;
  return previewAssets(project,record)?record:null;
}
