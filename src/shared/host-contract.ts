/** The APIs the plugin consumes, independent of the host's release number. */
interface ConditionalMethods { service:string; methods:readonly string[] }
interface ApiContract {
  required:readonly string[];
  services?:readonly ConditionalMethods[];
  optional?:readonly string[];
}

const hostContract:ApiContract={
  required:['effect','connection.fetch.register','llm.listProviders','llm.listModels','llm.stream','tools.register'],
  // These services already have a missing-service fallback or feature error.
  services:[
    {service:'jobs',methods:['jobs.start']},
    {service:'attachments',methods:['attachments.readImage','attachments.fileHostPath']},
    {service:'sessionController',methods:['sessionController.list']},
  ],
  optional:['get','llm.resolveModelInfo','sessionController.projections'],
};
const clientContract:ApiContract={
  required:[
    'effect','on','connection.rpc.call','slots.inject','slots.register','locale.register','locale.bind',
    'layout.selectPanel','layout.panelInfo.getSnapshot','layout.panelInfo.subscribe','uiWorkspace.openSession',
    'sessions.list.getSnapshot','sessions.list.subscribe','sessions.refresh','sessions.refreshProjections','sessions.subagentAddress',
    'workspaces.list.getSnapshot','workspaces.list.subscribe',
  ],
  services:[{service:'theme',methods:['theme.getTheme']}],
};

/** Read through normal property access: Cordis exposes inherited and proxied services. */
function readPath(context:unknown,path:string):unknown {
  let value=context;
  try {
    for(const key of path.split('.')){
      if(value===null||(typeof value!=='object'&&typeof value!=='function'))return undefined;
      value=Reflect.get(value,key);
    }
    return value;
  }catch{
    // A Cordis accessor may reject an unavailable service. Treat it like a
    // missing API and report the plugin path, rather than leaking its internals.
    return undefined;
  }
}

export class DshHostContractError extends Error {
  readonly code='DSH_HOST_API_UNAVAILABLE';
  constructor(readonly side:'服务端'|'客户端',readonly missingMethods:readonly string[]){
    super(`映流视频工作台无法启动：DSH ${side}缺少所需插件 API：\n${missingMethods.map(path=>`- ctx.${path}`).join('\n')}\n请检查 DSH 插件内核和相关服务是否完整加载。`);
    this.name='DshHostContractError';
  }
}

function assertContract(context:unknown,side:'服务端'|'客户端',contract:ApiContract):void {
  const methods=[...contract.required];
  for(const {service,methods:conditional} of contract.services??[]){
    const value=readPath(context,service);
    if(value!==undefined&&value!==null)methods.push(...conditional);
  }
  for(const path of contract.optional??[]){
    const value=readPath(context,path);
    if(value!==undefined&&value!==null)methods.push(path);
  }
  const missing=methods.filter(path=>typeof readPath(context,path)!=='function');
  if(missing.length)throw new DshHostContractError(side,missing);
}

/** Call before constructing services or registering resources. No API is invoked. */
export function assertHostContract(context:unknown):void {assertContract(context,'服务端',hostContract);}
export function assertClientContract(context:unknown):void {assertContract(context,'客户端',clientContract);}
