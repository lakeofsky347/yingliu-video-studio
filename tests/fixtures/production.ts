import {createProject,defaultProductionPolicy} from '../../src/core/index.js';
import type {VideoProject} from '../../src/shared/types.js';
/** These rendering fixtures explicitly request code animation; product defaults stay unresolved. */
export function createCodeProject(title:string,topic=''):VideoProject{return createProject(title,topic,'code_animation');}
export function grantHybrid(project:VideoProject,shotIds:string[],baseMode:'code_animation'|'model_video'='code_animation'):void {
  project.productionPolicy={...defaultProductionPolicy('hybrid'),baseMode,allowImportedVideo:true,
    hybridGrants:[{id:'fixture-user-decision',projectId:project.id,shotIds,operations:['code','video'],confirmedAt:'2026-11-06T00:00:00.000Z'}]};
}
